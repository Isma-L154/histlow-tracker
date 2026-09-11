"""Run state kept between executions: when work last ran, and what was already reported.

Re-alerting is asymmetric on purpose: a game reported at 9.99 stays quiet at
9.99 and 10.99, and reports again only at a genuinely better price.
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
    price: Money
    alerted_at: datetime


class TrackerState:
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

    @classmethod
    def load(cls, path: Path) -> TrackerState:
        document = read_json(path, default={})
        if not isinstance(document, dict) or document.get("version") != STATE_VERSION:
            # Discarding risks one duplicate notification; guessing at an old
            # layout could suppress a real one.
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

    @property
    def last_run_at(self) -> datetime | None:
        return self._last_run_at

    def should_alert(self, app_id: int, price: Money, *, threshold_minor: int) -> bool:
        """True when this price is worth interrupting the user for.

        A different currency means the region changed, so the old price is not comparable.
        """
        previous = self._alerts.get(app_id)
        if previous is None:
            return True
        if previous.price.currency != price.currency:
            return True
        return previous.price.minor_units - price.minor_units >= threshold_minor

    def alerted_at(self, app_id: int, price: Money) -> datetime | None:
        """When this app was last reported, provided it was at exactly this price."""
        previous = self._alerts.get(app_id)
        if previous is None or previous.price != price:
            return None
        return previous.alerted_at

    def record_alert(self, app_id: int, price: Money, *, now: datetime) -> None:
        self._alerts[app_id] = AlertRecord(price=price, alerted_at=now)
        self._dirty = True

    def mark_run(self, now: datetime) -> None:
        self._last_run_at = now
        self._dirty = True

    def purge_expired(self, *, retention: timedelta, now: datetime) -> None:
        """Drops records older than `retention`, which lets those games alert again."""
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
        # One bad record costs at most one duplicate notification, not the whole file.
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
