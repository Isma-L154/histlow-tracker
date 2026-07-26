"""Permanent cache of the Steam app id to ITAD game id mapping.

ITAD's lookup endpoint resolves one app per request, making it the only part of
the pipeline that scales linearly with the number of discounted games. The
mapping is immutable in practice, so caching it turns a recurring cost into a
one-off: an app is resolved once in the project's lifetime.

Misses are cached too, with an expiry. Without that, an app ITAD does not carry
would be re-queried on every single run forever. With a permanent negative
entry, a game later added to ITAD's catalogue would never be picked up. A dated
negative entry resolves both.
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

#: How long to remember that ITAD did not know an app. Short enough that a
#: newly catalogued game is picked up within a sale season, long enough that
#: permanently unknown apps cost almost nothing.
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
    """An in-memory view of the mapping, persisted on demand."""

    def __init__(self, path: Path, entries: dict[int, _Entry] | None = None) -> None:
        self._path = path
        self._entries: dict[int, _Entry] = entries or {}
        self._dirty = False

    # -- construction -------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> IdentityCache:
        document = read_json(path, default={})
        if not isinstance(document, dict) or document.get("version") != CACHE_VERSION:
            # A version bump discards the cache rather than guessing at an old
            # layout. Rebuilding costs one round of lookups.
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

    # -- queries ------------------------------------------------------------

    def get(self, app_id: int, *, now: datetime | None = None) -> GameIdentity | None:
        """Returns a cached identity, or None when unknown or expired."""
        entry = self._entries.get(app_id)
        if entry is None:
            return None

        if entry.itad_id is None:
            if self._is_expired(entry, now or datetime.now(tz=UTC)):
                del self._entries[app_id]
                self._dirty = True
            return None

        return GameIdentity(app_id=app_id, itad_id=entry.itad_id, title=entry.title or "")

    def knows(self, app_id: int, *, now: datetime | None = None) -> bool:
        """True when the app needs no lookup, including a live negative entry."""
        entry = self._entries.get(app_id)
        if entry is None:
            return False
        if entry.is_negative:
            return not self._is_expired(entry, now or datetime.now(tz=UTC))
        return True

    # -- mutation -----------------------------------------------------------

    def remember(self, identity: GameIdentity, *, now: datetime | None = None) -> None:
        self._entries[identity.app_id] = _Entry(
            itad_id=identity.itad_id,
            title=identity.title,
            resolved_at=now or datetime.now(tz=UTC),
        )
        self._dirty = True

    def remember_missing(self, app_id: int, *, now: datetime | None = None) -> None:
        self._entries[app_id] = _Entry(
            itad_id=None, title=None, resolved_at=now or datetime.now(tz=UTC)
        )
        self._dirty = True

    def save(self) -> None:
        """Persists the cache, skipping the write when nothing changed."""
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

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _is_expired(entry: _Entry, now: datetime) -> bool:
        return now - entry.resolved_at > NEGATIVE_TTL

    def __len__(self) -> int:
        return len(self._entries)


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
