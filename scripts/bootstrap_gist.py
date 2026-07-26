"""One-off helper: create the secret gist that bridges to the iOS Shortcut.

Run once during setup:

    python scripts/bootstrap_gist.py

It creates a secret gist holding an empty payload, writes `GIST_ID` into
`.env`, and saves the Shortcut's URL to `var/shortcut-url.txt`.

Neither the token, the gist id nor the raw URL is ever printed. A secret gist
is unlisted and unsearchable, but its URL is unguessable rather than
access-controlled, so the URL is itself a credential and is treated like one -
writing it to a git-ignored file instead of the terminal keeps it out of shell
history, scrollback and any transcript.

Its contents are public store data - app ids, titles and prices - with no
account identifier, so the worst case of disclosure is revealing which games
are on sale.
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
ENV_PATH = Path(".env")
URL_PATH = Path("var/shortcut-url.txt")

INITIAL_PAYLOAD = {
    "version": 1,
    "generated_at": None,
    "count": 0,
    "headline": "",
    "summary": "",
    "deals": [],
}


def main() -> int:
    environment = merge_environment(dict(os.environ), read_dotenv(ENV_PATH))
    token = environment.get("GIST_TOKEN", "").strip()

    if not token:
        print(
            "GIST_TOKEN is not set.\n\n"
            "Create a token whose only scope is 'gist' at\n"
            "  https://github.com/settings/tokens\n"
            "then add it to .env as GIST_TOKEN=...",
            file=sys.stderr,
        )
        return 1

    if environment.get("GIST_ID", "").strip():
        print(
            "GIST_ID is already set. Delete it from .env first if you really want "
            "a new gist; the existing one would otherwise be orphaned.",
            file=sys.stderr,
        )
        return 1

    try:
        gist = HttpClient().post_json(
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
        print("Confirm the token is valid and carries the 'gist' scope.", file=sys.stderr)
        return 1

    gist_id = str(gist.get("id", ""))
    entry = (gist.get("files") or {}).get(PAYLOAD_FILENAME, {})
    raw_url = _stable_raw_url(entry.get("raw_url", ""))
    if not gist_id or not raw_url:
        print("GitHub accepted the request but returned an unexpected shape.", file=sys.stderr)
        return 1

    _write_env_value(ENV_PATH, "GIST_ID", gist_id)

    URL_PATH.parent.mkdir(parents=True, exist_ok=True)
    URL_PATH.write_text(raw_url + "\n", encoding="utf-8")

    print("Secret gist created.")
    print(f"  GIST_ID written to {ENV_PATH}  ({len(gist_id)} chars)")
    print(f"  Shortcut URL written to {URL_PATH}")
    print()
    print("Open that file to copy the URL into the Shortcut. Treat it as a secret:")
    print("anyone holding it can read the payload. It is git-ignored.")
    return 0


def _stable_raw_url(raw_url: str) -> str:
    """Strips the revision hash so the URL always serves the latest content."""
    marker = "/raw/"
    if marker not in raw_url:
        return raw_url
    prefix, _, remainder = raw_url.partition(marker)
    return f"{prefix}{marker}{remainder.split('/')[-1]}"


def _write_env_value(path: Path, key: str, value: str) -> None:
    """Sets one key in `.env`, leaving every other line untouched."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    for index, line in enumerate(lines):
        if line.strip().startswith(f"{key}="):
            lines[index] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
