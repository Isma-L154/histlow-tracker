"""Publishes the payload to a secret GitHub gist, which the iOS Shortcut polls.

iOS allows no server push without an installed app, so the phone pulls. The
gist URL is unguessable rather than access-controlled, so it is treated as a
secret, and the token is scoped to `gist` alone to bound what a leak can do.
"""

from __future__ import annotations

import json
import logging
from typing import Protocol

from .net import HttpClient, PermanentHttpError

log = logging.getLogger(__name__)

GISTS_URL = "https://api.github.com/gists"
PAYLOAD_FILENAME = "histlow.json"

GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


class PublishError(RuntimeError):
    """The payload could not be published."""


class Publisher(Protocol):
    def publish(self, payload: dict) -> None: ...


class GistPublisher:
    """Writes the payload into one file of an existing secret gist."""

    def __init__(self, http: HttpClient, *, token: str, gist_id: str) -> None:
        self._http = http
        self._gist_id = gist_id
        self._headers = {"Authorization": f"Bearer {token}", **GITHUB_HEADERS}

    def publish(self, payload: dict) -> None:
        try:
            self._http.patch_json(
                f"{GISTS_URL}/{self._gist_id}",
                payload={"files": {PAYLOAD_FILENAME: {"content": _serialise(payload)}}},
                headers=self._headers,
            )
        except PermanentHttpError as exc:
            raise _classify(exc) from exc

        log.info("published %d deals to the gist", payload.get("count", 0))


class DryRunPublisher:
    """Prints the payload to stdout; logs go to stderr, so the output stays pipeable."""

    def publish(self, payload: dict) -> None:
        print(_serialise(payload))
        log.info("dry run: %d deals would have been published", payload.get("count", 0))


def _serialise(payload: dict) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)


def _classify(exc: PermanentHttpError) -> PublishError:
    # Safe for a CI log: neither the token nor the gist id is echoed.
    if exc.status in (401, 403):
        return PublishError(
            "GitHub rejected the gist token. Confirm GIST_TOKEN is valid and carries "
            "the 'gist' scope."
        )
    if exc.status == 404:
        return PublishError(
            "The gist was not found. Confirm GIST_ID is correct and that the token "
            "belongs to the account that owns it."
        )
    return PublishError(f"could not publish the payload: {exc}")
