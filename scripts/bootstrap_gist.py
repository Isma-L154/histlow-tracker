"""One-off helper: create the secret gist that bridges to the iOS Shortcut.

Run once during setup. It creates a secret gist holding an empty payload and
prints the two values needed afterwards: the gist id, which becomes the
GIST_ID secret, and the raw URL, which goes into the Shortcut.

    python scripts/bootstrap_gist.py

The token is read from GIST_TOKEN in the environment or `.env`. It is never
printed, and neither is anything derived from it.

A secret gist is unlisted and unsearchable, but its URL is unguessable rather
than access-controlled. Treat the raw URL as a secret. Its contents are public
store data - app ids, titles and prices - with no account identifier, so the
worst case of disclosure is revealing which games are on sale.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from histlow.dotenv import merge_environment, read_dotenv
from histlow.net import HttpClient, HttpError
from histlow.publisher import GISTS_URL, PAYLOAD_FILENAME

DESCRIPTION = "Steam HistLow Tracker payload (read by an iOS Shortcut)"

INITIAL_PAYLOAD = {
    "version": 1,
    "generated_at": None,
    "count": 0,
    "headline": "",
    "summary": "",
    "deals": [],
}


def main() -> int:
    environment = merge_environment(dict(os.environ), read_dotenv(Path(".env")))
    token = environment.get("GIST_TOKEN", "").strip()

    if not token:
        print(
            "GIST_TOKEN is not set.\n\n"
            "Create a token with the 'gist' scope only at\n"
            "  https://github.com/settings/tokens\n"
            "then add it to .env as GIST_TOKEN=...",
            file=sys.stderr,
        )
        return 1

    client = HttpClient()
    try:
        gist = client.post_json(
            GISTS_URL,
            payload={
                "description": DESCRIPTION,
                "public": False,
                "files": {PAYLOAD_FILENAME: {"content": json.dumps(INITIAL_PAYLOAD, indent=2)}},
            },
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    except HttpError as exc:
        print(f"Could not create the gist: {exc}", file=sys.stderr)
        print(
            "Confirm the token is valid and carries the 'gist' scope.",
            file=sys.stderr,
        )
        return 1

    gist_id = gist.get("id", "")
    raw_url = (gist.get("files") or {}).get(PAYLOAD_FILENAME, {}).get("raw_url", "")

    # The raw URL carries a revision hash that changes on every update. The
    # Shortcut needs the stable form, which omits it.
    stable_url = _stable_raw_url(raw_url, gist_id)

    print("Secret gist created.\n")
    print(f"  GIST_ID   {gist_id}")
    print("            -> add to .env and to the repository secrets\n")
    print(f"  Raw URL   {stable_url}")
    print("            -> paste into the iOS Shortcut's 'Get Contents of URL' action")
    print("            -> treat as a secret: anyone with it can read the payload")
    return 0


def _stable_raw_url(raw_url: str, gist_id: str) -> str:
    """Strips the revision hash so the URL always serves the latest content."""
    marker = "/raw/"
    if marker not in raw_url:
        return raw_url
    prefix, _, remainder = raw_url.partition(marker)
    filename = remainder.split("/")[-1]
    return f"{prefix}{marker}{filename}" if gist_id else raw_url


if __name__ == "__main__":
    sys.exit(main())
