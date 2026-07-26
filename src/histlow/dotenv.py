"""A minimal `.env` reader for local runs.

CI supplies everything through the process environment, so this exists purely
so a developer can keep credentials in a git-ignored file instead of exporting
them by hand. It is a deliberately small subset of the format: `KEY=value`,
optional surrounding quotes, `#` comments, blank lines.

Real environment variables always win. A shell export is the more explicit
signal of intent, and having the file silently override it would be surprising.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)


def read_dotenv(path: Path) -> dict[str, str]:
    """Parses `path`, returning an empty mapping when it does not exist."""
    try:
        # utf-8-sig so a Windows editor's byte order mark does not end up
        # glued to the first key name, which would silently lose that value.
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        log.warning("could not read %s (%s); ignoring it", path.name, exc)
        return {}

    values: dict[str, str] = {}
    for number, line in enumerate(raw.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        key, separator, value = stripped.partition("=")
        if not separator:
            # The line number is safe to log; the line itself may hold a secret.
            log.warning("%s line %d is not KEY=value; ignoring it", path.name, number)
            continue

        values[key.strip()] = _unquote(value.strip())

    return values


def merge_environment(env: dict[str, str], dotenv: dict[str, str]) -> dict[str, str]:
    """Overlays `dotenv` beneath `env`, so real variables take precedence."""
    return {**dotenv, **env}


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value
