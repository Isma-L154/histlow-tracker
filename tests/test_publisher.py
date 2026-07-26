"""Tests for gist publishing."""

from __future__ import annotations

import json
from typing import Any

import pytest

from histlow.net import PermanentHttpError
from histlow.publisher import (
    PAYLOAD_FILENAME,
    DryRunPublisher,
    GistPublisher,
    PublishError,
)

TOKEN = "gist-token-value"
GIST_ID = "abc123def456"
RAW_URL = f"https://gist.githubusercontent.com/u/{GIST_ID}/raw/deadbeef/{PAYLOAD_FILENAME}"

PAYLOAD = {"version": 1, "count": 2, "headline": "2 en minimo historico"}


class FakeHttp:
    def __init__(self, outcome: Any) -> None:
        self._outcome = outcome
        self.calls: list[dict[str, Any]] = []

    def patch_json(self, url: str, *, payload: Any, headers: dict | None = None) -> Any:
        self.calls.append({"url": url, "payload": payload, "headers": headers or {}})
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def success_response() -> dict:
    return {"files": {PAYLOAD_FILENAME: {"raw_url": RAW_URL}}}


def make_publisher(outcome: Any) -> tuple[GistPublisher, FakeHttp]:
    http = FakeHttp(outcome)
    return GistPublisher(http, token=TOKEN, gist_id=GIST_ID), http  # type: ignore[arg-type]


class TestGistPublisher:
    def test_patches_the_named_file_in_the_gist(self) -> None:
        publisher, http = make_publisher(success_response())

        publisher.publish(PAYLOAD)

        call = http.calls[0]
        assert call["url"].endswith(f"/gists/{GIST_ID}")
        content = call["payload"]["files"][PAYLOAD_FILENAME]["content"]
        assert json.loads(content) == PAYLOAD

    def test_sends_a_bearer_token_and_the_api_version(self) -> None:
        publisher, http = make_publisher(success_response())
        publisher.publish(PAYLOAD)

        headers = http.calls[0]["headers"]
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert headers["X-GitHub-Api-Version"] == "2022-11-28"

    def test_returns_the_raw_url_from_the_response(self) -> None:
        # GitHub rewrites the revision hash on every change, so the URL has to
        # be read back rather than constructed.
        publisher, _ = make_publisher(success_response())
        assert publisher.publish(PAYLOAD) == RAW_URL

    def test_non_ascii_titles_survive_the_round_trip(self) -> None:
        publisher, http = make_publisher(success_response())
        publisher.publish({"summary": "Ori — 9,99 € · Café"})

        content = http.calls[0]["payload"]["files"][PAYLOAD_FILENAME]["content"]
        assert json.loads(content)["summary"] == "Ori — 9,99 € · Café"

    def test_a_missing_raw_url_is_tolerated(self) -> None:
        publisher, _ = make_publisher({"files": {}})
        assert publisher.publish(PAYLOAD) == ""

    @pytest.mark.parametrize("status", [401, 403])
    def test_a_rejected_token_reports_the_required_scope(self, status: int) -> None:
        error = PermanentHttpError("denied")
        error.status = status
        publisher, _ = make_publisher(error)

        with pytest.raises(PublishError, match="gist"):
            publisher.publish(PAYLOAD)

    def test_a_missing_gist_is_reported_distinctly(self) -> None:
        error = PermanentHttpError("not found")
        error.status = 404
        publisher, _ = make_publisher(error)

        with pytest.raises(PublishError, match="GIST_ID"):
            publisher.publish(PAYLOAD)

    def test_failure_messages_never_contain_the_token(self) -> None:
        for status in (401, 403, 404, 422):
            error = PermanentHttpError("failed")
            error.status = status
            publisher, _ = make_publisher(error)

            with pytest.raises(PublishError) as excinfo:
                publisher.publish(PAYLOAD)
            assert TOKEN not in str(excinfo.value)


class TestDryRunPublisher:
    def test_writes_the_payload_to_stdout(self, capsys: pytest.CaptureFixture) -> None:
        result = DryRunPublisher().publish(PAYLOAD)

        assert json.loads(capsys.readouterr().out) == PAYLOAD
        assert "dry run" in result
