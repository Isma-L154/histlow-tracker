"""Atomic JSON persistence for the on-disk cache and alert state.

Both files are restored from the GitHub Actions cache at the start of a run and
saved at the end. A run cancelled mid-write must never leave a truncated file
behind: a corrupt identity cache would cost a round of redundant lookups, but a
corrupt alert state would re-notify every game already reported.

`os.replace` is atomic on both POSIX and Windows, so a reader sees either the
previous complete file or the new complete file, never a partial one.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def read_json(path: Path, default: Any) -> Any:
    """Reads `path`, falling back to `default` for any recoverable problem.

    A missing file is the normal first-run case. A corrupt file is degraded
    rather than fatal: losing cached state costs one noisier run, whereas
    aborting would leave the tracker permanently broken until someone
    intervened manually.
    """
    try:
        # utf-8-sig for the same reason as elsewhere: these files are written
        # by this program, but a user may open and re-save one while debugging.
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return default
    except OSError as exc:
        log.warning("could not read %s (%s); continuing with defaults", path.name, exc)
        return default

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("%s is corrupt (%s); continuing with defaults", path.name, exc)
        return default


def write_json_atomic(path: Path, payload: Any) -> None:
    """Writes `payload` to `path` via a temporary file and an atomic rename."""
    path.parent.mkdir(parents=True, exist_ok=True)

    # The temporary file is created in the destination directory so that
    # `os.replace` stays within one filesystem and therefore stays atomic.
    descriptor, temp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temp_path = Path(temp_name)
    try:
        with open(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise
