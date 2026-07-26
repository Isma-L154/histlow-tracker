"""Run state persisted between executions.

Holds two things:

* When the pipeline last did real work, which drives the scheduling gate.
* Which games have already been alerted on and at what price, which is what
  stops a week-long sale from producing the same notification every few hours.

The re-alert rule is deliberately asymmetric. A game already reported at 9.99
stays quiet at 9.99 and at 10.99, but reports again at 8.99. Only a genuinely
better price is worth interrupting someone for.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .domain import DomainError, Money
from .storage import read_json, write_json_atomic

log = logging.getLogger(__name__)

STATE_VERSION = 1


@dataclass(frozen=True, slots=True)
class AlertRecord:
    """The last price at which a given app was reported."""

    price: Money
    alerted_at: datetime


class TrackerState:
    """An in-memory view of run state, persisted on demand."""

    def __init__(
        self,
        path: Path,
        alerts: dict[int, AlertRecord] | None = None,
        last_run_at: datetime | None = None,
    ) -> None:
        self._path = path
        self._alerts: dict[int, AlertRecord] = alerts or {}
        self._last_run_at = last_run_at
        self._dirty = False

    # -- construction -------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> TrackerState:
        document = read_json(path, default={})
        if not isinstance(document, dict) or document.get("version") != STATE_VERSION:
            # Discarding on a version bump can cause one duplicate notification.
            # Guessing at an old layout could suppress a real one, which is worse.
            return cls(path)

        alerts: dict[int, AlertRecord] = {}
        for key, value in (document.get("alerts") or {}).items():
            record = _parse_record(value)
            if record is None:
                continue
            try:
                alerts[int(key)] = record
            except (TypeError, ValueError):
                continue

        return cls(path, alerts, _parse_datetime(document.get("last_run_at")))

    # -- queries ------------------------------------------------------------

    @property
    def last_run_at(self) -> datetime | None:
        return self._last_run_at

    def should_alert(self, app_id: int, price: Money, *, threshold_minor: int) -> bool:
        """True when this price is worth interrupting the user for.

        A differing currency is treated as never-alerted: the storefront region
        changed, so the recorded price is not comparable and suppressing on it
        would hide a real deal.
        """
        previous = self._alerts.get(app_id)
        if previous is None:
            return True
        if previous.price.currency != price.currency:
            return True
        return previous.price.minor_units - price.minor_units >= threshold_minor

    # -- mutation -----------------------------------------------------------

    def record_alert(self, app_id: int, price: Money, *, now: datetime) -> None:
        self._alerts[app_id] = AlertRecord(price=price, alerted_at=now)
        self._dirty = True

    def mark_run(self, now: datetime) -> None:
        self._last_run_at = now
        self._dirty = True

    def purge_expired(self, *, retention: timedelta, now: datetime) -> int:
        """Drops records older than `retention` so the file cannot grow forever.

        An expired record simply allows the game to alert again, which is the
        desired behaviour years after the fact.
        """
        stale = [
            app_id
            for app_id, record in self._alerts.items()
            if now - record.alerted_at > retention
        ]
        for app_id in stale:
            del self._alerts[app_id]
        if stale:
            self._dirty = True
            log.debug("purged %d expired alert records", len(stale))
        return len(stale)

    def save(self) -> None:
        if not self._dirty:
            return
        write_json_atomic(
            self._path,
            {
                "version": STATE_VERSION,
                "last_run_at": self._last_run_at.isoformat() if self._last_run_at else None,
                "alerts": {
                    str(app_id): {
                        "price_minor": record.price.minor_units,
                        "currency": record.price.currency,
                        "alerted_at": record.alerted_at.isoformat(),
                    }
                    for app_id, record in sorted(self._alerts.items())
                },
            },
        )
        self._dirty = False

    def __len__(self) -> int:
        return len(self._alerts)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_record(value: Any) -> AlertRecord | None:
    if not isinstance(value, dict):
        return None

    minor = value.get("price_minor")
    currency = value.get("currency")
    alerted_at = _parse_datetime(value.get("alerted_at"))
    if not isinstance(minor, int) or not isinstance(currency, str) or alerted_at is None:
        return None

    try:
        return AlertRecord(price=Money(minor, currency.upper()), alerted_at=alerted_at)
    except DomainError:
        # One malformed record must not discard the whole file. Dropping it
        # costs at most a single duplicate notification for that game.
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
