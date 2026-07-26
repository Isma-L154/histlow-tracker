"""Shared test helpers."""

from __future__ import annotations

from datetime import UTC, datetime

from histlow.domain import Deal, Money, RecordStatus

DEFAULT_MOMENT = datetime(2026, 7, 25, 18, 0, tzinfo=UTC)


def make_deal(
    *,
    app_id: int = 1,
    title: str = "A Game",
    current: int = 999,
    regular: int = 1999,
    discount: int = 50,
    low: int = 999,
    currency: str = "EUR",
    record: RecordStatus | None = None,
) -> Deal:
    """Builds a Deal with sensible defaults, for tests that do not care."""
    return Deal(
        app_id=app_id,
        title=title,
        current=Money(current, currency),
        regular=Money(regular, currency),
        discount_percent=discount,
        reference_current=Money(current, currency),
        reference_low=Money(low, currency),
        low_recorded_at=DEFAULT_MOMENT,
        record=record or RecordStatus.unknown(),
    )
