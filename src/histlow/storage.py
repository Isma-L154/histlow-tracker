"""Atomic JSON persistence for the identity cache and alert state.

A run cancelled mid-write must never leave a truncated file: a corrupt alert
state would re-notify every game already reported.
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
    """Reads `path`, falling back to `default` when it is missing or corrupt.

    Degrading costs one noisier run; aborting would leave the tracker broken
    until someone intervened.
    """
    try:
        # utf-8-sig: a user may re-save the file in an editor that adds a BOM.
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
    """Writes via a temporary file and `os.replace`, which is atomic on POSIX and Windows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Same directory as the target, so the rename never crosses filesystems.
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
