"""A small hardened JSON-over-HTTPS client built on the standard library.

Using `urllib` rather than `requests`/`httpx` keeps the runtime dependency
count at zero, which removes the third-party supply chain from the threat model
entirely and lets CI skip the install step.

Hardening applied here:

* HTTPS is mandatory and a redirect may never downgrade the scheme.
* Redirects may never cross to a different host. `urllib` replays request
  headers on redirect, so a cross-host hop would hand an API token to whoever
  controls the redirect target.
* Every request carries an explicit timeout; a hung socket cannot stall the job.
* Responses are size-capped before being read into memory.
* Failures are classified as transient (worth retrying) or permanent (a bug or
  a bad credential, retrying only wastes quota).
* Backoff is exponential with jitter and honours `Retry-After`.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_BACKOFF_BASE_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0

#: Well beyond any payload this tracker handles; a wishlist of several hundred
#: titles serialises to under 2 MB. Guards against a malformed or hostile
#: response exhausting the runner's memory.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024

USER_AGENT = "histlow-tracker/0.1 (+https://github.com/Isma-L154/histlow-tracker)"

_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class HttpError(Exception):
    """Base class for every failure raised by :class:`HttpClient`."""


class TransientHttpError(HttpError):
    """The endpoint may succeed later: timeout, throttling or a 5xx."""


class PermanentHttpError(HttpError):
    """Retrying cannot help: bad credentials, bad request, blocked redirect."""


class _StrictRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Allows redirects only when they stay on the same host and remain HTTPS."""

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
    """Performs JSON requests with retries, backoff and strict redirect rules.

    A single instance is shared across adapters so that connection handling and
    retry policy stay uniform. Instances are cheap; they hold no mutable state
    beyond the opener.
    """

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        backoff_base: float = DEFAULT_BACKOFF_BASE_SECONDS,
        user_agent: str = USER_AGENT,
        sleep: Any = time.sleep,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._backoff_base = backoff_base
        self._user_agent = user_agent
        # Injected so tests exercise the retry ladder without real delays.
        self._sleep = sleep
        self._opener = urllib.request.build_opener(_StrictRedirectHandler)

    # -- public API ---------------------------------------------------------

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
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        merged = {"Content-Type": "application/json", **(headers or {})}
        return self._request_with_retries("POST", url, params=params, headers=merged, body=body)

    def patch_json(
        self,
        url: str,
        *,
        payload: Any,
        headers: dict[str, str] | None = None,
    ) -> Any:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        merged = {"Content-Type": "application/json", **(headers or {})}
        return self._request_with_retries("PATCH", url, params=None, headers=merged, body=body)

    # -- internals ----------------------------------------------------------

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
            except PermanentHttpError:
                raise
            except TransientHttpError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                delay = self._backoff_delay(attempt, getattr(exc, "retry_after", None))
                # `_safe_url` strips the query string: ITAD accepts its API key
                # as a query parameter, so a full URL must never be logged.
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

        # S310 flags unvalidated schemes; the guard above restricts this call
        # to HTTPS, and `_StrictRedirectHandler` keeps every hop on HTTPS too.
        request = urllib.request.Request(full_url, data=body, method=method)  # noqa: S310
        request.add_header("User-Agent", self._user_agent)
        request.add_header("Accept", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)

        safe = _safe_url(full_url)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return _read_capped(response)
        except urllib.error.HTTPError as exc:
            raise _classify_http_error(exc, full_url) from exc
        except urllib.error.URLError as exc:
            raise TransientHttpError(f"network failure for {safe}: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TransientHttpError(f"timeout after {self._timeout}s for {safe}") from exc

    def _backoff_delay(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, MAX_BACKOFF_SECONDS)
        exponential = self._backoff_base * (2 ** (attempt - 1))
        # Full jitter: spreads concurrent retries instead of synchronising them
        # into a second thundering herd against an already struggling endpoint.
        return min(exponential, MAX_BACKOFF_SECONDS) * (0.5 + random.random() / 2)  # noqa: S311


def _classify_http_error(exc: urllib.error.HTTPError, url: str) -> HttpError:
    detail = f"{exc.code} {exc.reason} for {_safe_url(url)}"
    if exc.code in _RETRYABLE_STATUS:
        error = TransientHttpError(detail)
        error.retry_after = _parse_retry_after(exc.headers.get("Retry-After"))  # type: ignore[attr-defined]
        return error
    return PermanentHttpError(detail)


def _parse_retry_after(value: str | None) -> float | None:
    """Reads the delta-seconds form of `Retry-After`.

    The HTTP-date form is ignored on purpose: the ordinary backoff ladder is a
    safe fallback, and date parsing would add clock-skew failure modes for no
    practical gain against the two APIs in use.
    """
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
    if not params:
        return url
    encoded = urllib.parse.urlencode(
        {k: v for k, v in params.items() if v is not None},
        doseq=True,
    )
    separator = "&" if urllib.parse.urlsplit(url).query else "?"
    return f"{url}{separator}{encoded}"


def _safe_url(url: str) -> str:
    """Drops the query string so credentials passed as parameters never log."""
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"
