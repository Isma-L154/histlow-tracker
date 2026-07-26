"""Publishes the payload to a secret GitHub gist.

The gist is the bridge to the phone. iOS will not let an external server push a
notification without a companion app installed, so the flow is inverted: the
workflow drops a small document at a stable URL and a Shortcuts automation
polls it. Shortcuts ships with iOS, so nothing has to be installed.

The gist is secret rather than public. A secret gist is unlisted and
unsearchable, though its URL is unguessable rather than access-controlled, so
the URL itself is treated as a secret. The contents are public store data -
app ids, titles, prices - and carry no account identifier, which bounds the
worst case to disclosing which games are on sale.

The token is scoped to `gist` alone. It is the only credential the workflow can
leak, and that scope confines the damage to gists.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from .net import HttpClient, PermanentHttpError

log = logging.getLogger(__name__)

GISTS_URL = "https://api.github.com/gists"
PAYLOAD_FILENAME = "histlow.json"

_GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


class PublishError(RuntimeError):
    """The payload could not be published."""


class Publisher(Protocol):
    """Lets the pipeline stay identical in dry-run and live modes."""

    def publish(self, payload: dict) -> str: ...


class GistPublisher:
    """Writes the payload into a single file inside an existing secret gist."""

    def __init__(
        self,
        http: HttpClient,
        *,
        token: str,
        gist_id: str,
        filename: str = PAYLOAD_FILENAME,
    ) -> None:
        self._http = http
        self._gist_id = gist_id
        self._filename = filename
        self._headers = {"Authorization": f"Bearer {token}", **_GITHUB_HEADERS}

    def publish(self, payload: dict) -> str:
        """Updates the gist and returns the raw URL the Shortcut should poll.

        The raw URL is re-read from the response on every publish. GitHub
        rewrites the revision hash in that URL each time the content changes,
        and only the response knows the current one.
        """
        body = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)

        try:
            document = self._http.patch_json(
                f"{GISTS_URL}/{self._gist_id}",
                payload={"files": {self._filename: {"content": body}}},
                headers=self._headers,
            )
        except PermanentHttpError as exc:
            raise _classify(exc) from exc

        log.info("published %d deals to the gist", payload.get("count", 0))
        return _extract_raw_url(document, self._filename)


class DryRunPublisher:
    """Prints the payload to stdout instead of publishing it.

    Writing to stdout keeps the output pipeable while logs go to stderr.
    """

    def publish(self, payload: dict) -> str:
        print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
        log.info("dry run: %d deals would have been published", payload.get("count", 0))
        return "(dry run, nothing published)"


def _extract_raw_url(document: Any, filename: str) -> str:
    if not isinstance(document, dict):
        return ""
    entry = (document.get("files") or {}).get(filename)
    if not isinstance(entry, dict):
        return ""
    raw_url = entry.get("raw_url")
    return raw_url if isinstance(raw_url, str) else ""


def _classify(exc: PermanentHttpError) -> PublishError:
    # None of these messages echo the token or the gist id: they are written to
    # be safe in a CI log.
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
