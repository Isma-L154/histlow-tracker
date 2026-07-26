"""Tests for the HTTP client's retry ladder and hardening rules.

No sockets are opened: `_perform` is substituted and `sleep` is injected, so
the retry ladder is exercised deterministically and instantly.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from typing import Any

import pytest

from histlow.net import (
    HttpClient,
    PermanentHttpError,
    TransientHttpError,
    _build_url,
    _classify_http_error,
    _parse_retry_after,
    _safe_url,
    _StrictRedirectHandler,
)


class _Recorder:
    """Stands in for `HttpClient._perform`, replaying a scripted sequence."""

    def __init__(self, *outcomes: Any) -> None:
        self._outcomes = list(outcomes)
        self.calls = 0

    def __call__(self, *_args: Any, **_kwargs: Any) -> bytes:
        self.calls += 1
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def slept() -> list[float]:
    return []


@pytest.fixture
def client(slept: list[float]) -> HttpClient:
    return HttpClient(max_attempts=3, backoff_base=1.0, sleep=slept.append)


class TestRetryLadder:
    def test_recovers_after_a_transient_failure(
        self, client: HttpClient, slept: list[float]
    ) -> None:
        client._perform = _Recorder(TransientHttpError("503"), b'{"ok":true}')  # type: ignore[method-assign]

        assert client.get_json("https://example.test/v1") == {"ok": True}
        assert len(slept) == 1

    def test_gives_up_after_max_attempts(self, client: HttpClient, slept: list[float]) -> None:
        recorder = _Recorder(*[TransientHttpError("503")] * 3)
        client._perform = recorder  # type: ignore[method-assign]

        with pytest.raises(TransientHttpError, match="after 3 attempts"):
            client.get_json("https://example.test/v1")

        assert recorder.calls == 3
        # Two waits for three attempts: no pointless sleep after the last try.
        assert len(slept) == 2

    def test_permanent_failures_are_not_retried(
        self, client: HttpClient, slept: list[float]
    ) -> None:
        recorder = _Recorder(PermanentHttpError("401 Unauthorized"))
        client._perform = recorder  # type: ignore[method-assign]

        with pytest.raises(PermanentHttpError):
            client.get_json("https://example.test/v1")

        assert recorder.calls == 1
        assert slept == []

    def test_backoff_grows_and_stays_jittered(self, client: HttpClient, slept: list[float]) -> None:
        client._perform = _Recorder(*[TransientHttpError("503")] * 3)  # type: ignore[method-assign]

        with pytest.raises(TransientHttpError):
            client.get_json("https://example.test/v1")

        # Full jitter keeps each delay within [0.5, 1.0] of the exponential.
        assert 0.5 <= slept[0] <= 1.0
        assert 1.0 <= slept[1] <= 2.0

    def test_retry_after_overrides_the_exponential_delay(
        self, client: HttpClient, slept: list[float]
    ) -> None:
        throttled = TransientHttpError("429")
        throttled.retry_after = 7.0  # type: ignore[attr-defined]
        client._perform = _Recorder(throttled, b"{}")  # type: ignore[method-assign]

        client.get_json("https://example.test/v1")
        assert slept == [7.0]

    def test_malformed_json_is_permanent(self, client: HttpClient) -> None:
        client._perform = _Recorder(b"<html>not json</html>")  # type: ignore[method-assign]

        with pytest.raises(PermanentHttpError, match="malformed JSON"):
            client.get_json("https://example.test/v1")


class TestSchemeEnforcement:
    def test_plain_http_is_refused(self) -> None:
        with pytest.raises(PermanentHttpError, match="non-HTTPS"):
            HttpClient(sleep=lambda _: None).get_json("http://example.test/v1")


class TestRedirectHandler:
    def _redirect(self, origin: str, target: str) -> None:
        handler = _StrictRedirectHandler()
        handler.redirect_request(
            urllib.request.Request(origin),  # noqa: S310 - fixed HTTPS test literals
            None,
            302,
            "Found",
            {},
            target,
        )

    def test_scheme_downgrade_is_blocked(self) -> None:
        with pytest.raises(PermanentHttpError, match="non-HTTPS"):
            self._redirect("https://api.example.test/v1", "http://api.example.test/v1")

    def test_cross_host_redirect_is_blocked(self) -> None:
        # Otherwise urllib would replay the API-key header to the new host.
        with pytest.raises(PermanentHttpError, match="cross-host"):
            self._redirect("https://api.example.test/v1", "https://evil.example/v1")

    def test_same_host_redirect_is_allowed(self) -> None:
        handler = _StrictRedirectHandler()
        result = handler.redirect_request(
            urllib.request.Request("https://api.example.test/v1"),
            None, 302, "Found", {}, "https://api.example.test/v2",
        )
        assert result is not None


class TestHelpers:
    def test_safe_url_drops_the_query_string(self) -> None:
        # ITAD accepts its API key as a query parameter, so full URLs must
        # never reach a log line.
        assert (
            _safe_url("https://api.isthereanydeal.com/games/lookup/v1?key=secret&appid=730")
            == "https://api.isthereanydeal.com/games/lookup/v1"
        )

    def test_build_url_appends_to_an_existing_query(self) -> None:
        assert _build_url("https://x.test/p?a=1", {"b": "2"}) == "https://x.test/p?a=1&b=2"

    def test_build_url_omits_none_values(self) -> None:
        assert _build_url("https://x.test/p", {"a": "1", "b": None}) == "https://x.test/p?a=1"

    def test_build_url_without_params_is_unchanged(self) -> None:
        assert _build_url("https://x.test/p", None) == "https://x.test/p"

    @pytest.mark.parametrize(
        ("header", "expected"),
        [
            ("12", 12.0),
            ("0", 0.0),
            (None, None),
            ("", None),
            # The HTTP-date form is intentionally unsupported; backoff covers it.
            ("Wed, 21 Oct 2026 07:28:00 GMT", None),
        ],
    )
    def test_retry_after_parsing(self, header: str | None, expected: float | None) -> None:
        assert _parse_retry_after(header) == expected

    @pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
    def test_retryable_statuses_classify_as_transient(self, status: int) -> None:
        error = _classify_http_error(_http_error(status), "https://x.test/p")
        assert isinstance(error, TransientHttpError)

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
    def test_client_errors_classify_as_permanent(self, status: int) -> None:
        error = _classify_http_error(_http_error(status), "https://x.test/p")
        assert isinstance(error, PermanentHttpError)


def _http_error(status: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://x.test/p", code=status, msg="err", hdrs={}, fp=None  # type: ignore[arg-type]
    )
