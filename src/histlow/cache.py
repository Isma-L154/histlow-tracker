"""Permanent cache of Steam app id to ITAD game id, since ITAD resolves one app per request.

Misses are cached too, but expire, so a game ITAD catalogues later is picked up
without re-querying unknown apps on every run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .domain import GameIdentity
from .storage import read_json, write_json_atomic

log = logging.getLogger(__name__)

CACHE_VERSION = 1
NEGATIVE_TTL = timedelta(days=30)


@dataclass(frozen=True, slots=True)
class _Entry:
    itad_id: str | None
    title: str | None
    resolved_at: datetime

    @property
    def is_negative(self) -> bool:
        return self.itad_id is None


class IdentityCache:
    def __init__(self, path: Path, entries: dict[int, _Entry] | None = None) -> None:
        self._path = path
        self._entries: dict[int, _Entry] = entries or {}
        self._dirty = False

    @classmethod
    def load(cls, path: Path) -> IdentityCache:
        document = read_json(path, default={})
        if not isinstance(document, dict) or document.get("version") != CACHE_VERSION:
            # An unknown layout is discarded; rebuilding costs one round of lookups.
            return cls(path)

        entries: dict[int, _Entry] = {}
        for key, value in (document.get("entries") or {}).items():
            entry = _parse_entry(value)
            if entry is None:
                continue
            try:
                entries[int(key)] = entry
            except (TypeError, ValueError):
                continue

        log.debug("identity cache loaded with %d entries", len(entries))
        return cls(path, entries)

    def knows(self, app_id: int, *, now: datetime) -> bool:
        """True when no lookup is needed, including for a miss that has not expired."""
        entry = self._entries.get(app_id)
        if entry is None:
            return False
        return not entry.is_negative or now - entry.resolved_at <= NEGATIVE_TTL

    def get(self, app_id: int) -> GameIdentity | None:
        entry = self._entries.get(app_id)
        if entry is None or entry.is_negative:
            return None
        return GameIdentity(app_id=app_id, itad_id=entry.itad_id, title=entry.title or "")

    def remember(self, identity: GameIdentity, *, now: datetime) -> None:
        self._entries[identity.app_id] = _Entry(identity.itad_id, identity.title, now)
        self._dirty = True

    def remember_missing(self, app_id: int, *, now: datetime) -> None:
        self._entries[app_id] = _Entry(None, None, now)
        self._dirty = True

    def save(self) -> None:
        if not self._dirty:
            return
        write_json_atomic(
            self._path,
            {
                "version": CACHE_VERSION,
                "entries": {
                    str(app_id): {
                        "itad_id": entry.itad_id,
                        "title": entry.title,
                        "resolved_at": entry.resolved_at.isoformat(),
                    }
                    for app_id, entry in sorted(self._entries.items())
                },
            },
        )
        self._dirty = False
        log.debug("identity cache saved with %d entries", len(self._entries))


def _parse_entry(value: Any) -> _Entry | None:
    if not isinstance(value, dict):
        return None
    try:
        resolved_at = datetime.fromisoformat(str(value["resolved_at"]))
    except (KeyError, TypeError, ValueError):
        return None
    if resolved_at.tzinfo is None:
        resolved_at = resolved_at.replace(tzinfo=UTC)

    itad_id = value.get("itad_id")
    title = value.get("title")
    if itad_id is not None and not isinstance(itad_id, str):
        return None
    if title is not None and not isinstance(title, str):
        return None

    return _Entry(itad_id=itad_id, title=title, resolved_at=resolved_at)
