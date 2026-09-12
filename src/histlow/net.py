"""A JSON-over-HTTPS client on the standard library, so the runtime has no dependencies.

Hardening: HTTPS only; no redirect that changes host or downgrades the scheme
(urllib replays headers, which would hand an API token to the new host); an
explicit timeout; a response size cap; and retries for transient failures only,
with jittered exponential backoff that honours `Retry-After`.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0
#: Far above any real payload; guards the runner's memory against a hostile response.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
USER_AGENT = "histlow-tracker/0.1 (+https://github.com/Isma-L154/histlow-tracker)"

_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class HttpError(Exception):
    """Base for every client failure; `status` holds the HTTP status when one arrived."""

    status: int | None = None


class TransientHttpError(HttpError):
    """Timeout, throttling or a 5xx: may succeed later."""

    retry_after: float | None = None


class PermanentHttpError(HttpError):
    """Bad credentials, a bad request or a blocked redirect: retrying cannot help."""


class _StrictRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        origin = urllib.parse.urlsplit(req.full_url)
        target = urllib.parse.urlsplit(newurl)

        if target.scheme != "https":
            raise PermanentHttpError(
                f"blocked redirect to non-HTTPS scheme {target.scheme!r} from {origin.netloc}"
            )
        if target.netloc != origin.netloc:
            raise PermanentHttpError(
                f"blocked cross-host redirect {origin.netloc} -> {target.netloc}; "
                "request headers would have been replayed to the new host"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HttpClient:
    """JSON requests with retries, backoff and strict redirect rules."""

    def __init__(
        self,
        *,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._opener = urllib.request.build_opener(_StrictRedirectHandler)

    def get_json(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return self._request_with_retries("GET", url, params=params, headers=headers, body=None)

    def post_json(
        self,
        url: str,
        *,
        payload: Any,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return self._send_json("POST", url, payload, params, headers)

    def patch_json(
        self, url: str, *, payload: Any, headers: dict[str, str] | None = None
    ) -> Any:
        return self._send_json("PATCH", url, payload, None, headers)

    def _send_json(
        self,
        method: str,
        url: str,
        payload: Any,
        params: dict[str, Any] | None,
        headers: dict[str, str] | None,
    ) -> Any:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        merged = {"Content-Type": "application/json", **(headers or {})}
        return self._request_with_retries(method, url, params=params, headers=merged, body=body)

    def _request_with_retries(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None,
        headers: dict[str, str] | None,
        body: bytes | None,
    ) -> Any:
        full_url = _build_url(url, params)
        last_error: Exception | None = None

        for attempt in range(1, self._max_attempts + 1):
            try:
                raw = self._perform(method, full_url, headers, body)
            except TransientHttpError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                delay = self._backoff_delay(attempt, exc.retry_after)
                log.warning(
                    "%s %s failed (attempt %d/%d): %s - retrying in %.1fs",
                    method,
                    _safe_url(full_url),
                    attempt,
                    self._max_attempts,
                    exc,
                    delay,
                )
                self._sleep(delay)
                continue

            try:
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                raise PermanentHttpError(
                    f"{method} {_safe_url(full_url)} returned malformed JSON: {exc}"
                ) from exc

        raise TransientHttpError(
            f"{method} {_safe_url(full_url)} failed after {self._max_attempts} attempts: "
            f"{last_error}"
        )

    def _perform(
        self,
        method: str,
        full_url: str,
        headers: dict[str, str] | None,
        body: bytes | None,
    ) -> bytes:
        scheme = urllib.parse.urlsplit(full_url).scheme
        if scheme != "https":
            raise PermanentHttpError(f"refusing non-HTTPS request to scheme {scheme!r}")

        # S310: the scheme is checked above and the redirect handler keeps every hop on HTTPS.
        request = urllib.request.Request(full_url, data=body, method=method)  # noqa: S310
        request.add_header("User-Agent", USER_AGENT)
        request.add_header("Accept", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)

        safe = _safe_url(full_url)
        try:
            with self._opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                return _read_capped(response)
        except urllib.error.HTTPError as exc:
            raise _classify_http_error(exc, full_url) from exc
        except urllib.error.URLError as exc:
            raise TransientHttpError(f"network failure for {safe}: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TransientHttpError(f"timeout after {TIMEOUT_SECONDS}s for {safe}") from exc

    def _backoff_delay(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, MAX_BACKOFF_SECONDS)
        exponential = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
        # Jitter keeps retries from synchronising into a second thundering herd.
        return min(exponential, MAX_BACKOFF_SECONDS) * (0.5 + random.random() / 2)  # noqa: S311


def _classify_http_error(exc: urllib.error.HTTPError, url: str) -> HttpError:
    detail = f"{exc.code} {exc.reason} for {_safe_url(url)}"
    error: HttpError
    if exc.code in _RETRYABLE_STATUS:
        error = TransientHttpError(detail)
        error.retry_after = _parse_retry_after(exc.headers.get("Retry-After"))
    else:
        error = PermanentHttpError(detail)
    error.status = exc.code
    return error


def _parse_retry_after(value: str | None) -> float | None:
    """Delta-seconds only; the HTTP-date form falls back to the normal backoff."""
    if not value:
        return None
    try:
        seconds = float(value.strip())
    except ValueError:
        return None
    return max(0.0, seconds)


def _read_capped(response: Any) -> bytes:
    data = response.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise PermanentHttpError(f"response exceeded the {MAX_RESPONSE_BYTES} byte cap")
    return data


def _build_url(url: str, params: dict[str, Any] | None) -> str:
    return f"{url}?{urllib.parse.urlencode(params)}" if params else url


def _safe_url(url: str) -> str:
    """Drops the query string, so a credential passed as a parameter never reaches a log."""
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"
