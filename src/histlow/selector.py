"""The decision rules, as pure functions: no network, clock or filesystem."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import datetime, timedelta

from .config import AlertRules
from .domain import (
    Deal,
    DomainError,
    GameIdentity,
    HistoricalLow,
    PricePoint,
    PriceQuote,
    RecordStatus,
)
from .state import TrackerState


def discounted_app_ids(quotes: Mapping[int, PriceQuote], rules: AlertRules) -> list[int]:
    """Apps discounted by at least the configured cut, sorted for reproducible runs."""
    return sorted(
        app_id
        for app_id, quote in quotes.items()
        if quote.discount_percent >= rules.min_discount_percent
    )


class CurrencyMismatchError(RuntimeError):
    """No comparison was possible because the currencies disagree.

    Raised rather than returning nothing, which would look exactly like a day
    with no deals, indefinitely.
    """


def qualifying_deals(
    store_quotes: Mapping[int, PriceQuote],
    reference_quotes: Mapping[int, PriceQuote],
    identities: Mapping[int, GameIdentity],
    lows: Mapping[int, HistoricalLow],
) -> list[Deal]:
    """Games priced at or below their all-time Steam low.

    Decided on `reference_quotes` against `lows`, which share a currency ITAD
    tracks, and shown from `store_quotes`. A game missing any input is skipped
    rather than guessed at. Matching the low counts: it is still the best price.
    """
    deals: list[Deal] = []
    comparable = 0
    mismatched = 0

    for app_id in sorted(store_quotes):
        identity = identities.get(app_id)
        low = lows.get(app_id)
        reference = reference_quotes.get(app_id)
        if identity is None or low is None or reference is None:
            continue

        try:
            qualifies = reference.current <= low.low
        except DomainError:
            mismatched += 1
            continue

        comparable += 1
        if not qualifies:
            continue

        deals.append(
            Deal(
                app_id=app_id,
                title=identity.title,
                current=store_quotes[app_id].current,
                regular=store_quotes[app_id].regular,
                discount_percent=store_quotes[app_id].discount_percent,
                reference_current=reference.current,
                reference_low=low.low,
                low_recorded_at=low.recorded_at,
            )
        )

    if mismatched and not comparable:
        raise CurrencyMismatchError(
            f"none of the {mismatched} candidate games could be compared: the Steam price "
            "and the ITAD historical low are quoted in different currencies. Set "
            "COMPARISON_COUNTRY to a region ITAD tracks (US is always safe)."
        )

    return deals


def unreported_deals(
    deals: Sequence[Deal], state: TrackerState, rules: AlertRules
) -> list[Deal]:
    """Drops deals already alerted on at the same or a better price."""
    return [
        deal
        for deal in deals
        if state.should_alert(
            deal.app_id, deal.current, threshold_minor=rules.reprice_threshold_minor
        )
    ]


def repeated_deals(
    deals: Sequence[Deal], state: TrackerState, rules: AlertRules, *, now: datetime
) -> list[Deal]:
    """Already-reported deals that stay in the payload for `repeat_for_days`.

    The phone polls, so a payload replaced between two polls is never read, and
    an alert once recorded is not published again. Only deals still at the
    recorded price come back.
    """
    if rules.repeat_for_days <= 0:
        return []

    window = timedelta(days=rules.repeat_for_days)
    return [
        deal
        for deal in deals
        if (alerted := state.alerted_at(deal.app_id, deal.current)) is not None
        and now - alerted <= window
    ]


def rank_for_payload(deals: Sequence[Deal], rules: AlertRules) -> list[Deal]:
    """Deepest discount first, capped so a storewide sale stays readable."""
    ordered = sorted(
        deals,
        key=lambda deal: (-deal.discount_percent, deal.title.casefold()),
    )
    return ordered[: rules.max_items_in_payload]


def classify_record(
    history: Sequence[PricePoint], low: HistoricalLow
) -> RecordStatus:
    """Whether the current sale set the all-time low, or only matched an older one.

    ITAD stamps a low and its history entry with the same instant, so the sale
    set the record exactly when the newest entry carries the low's timestamp.
    Prices cannot tell: ITAD updates the low the moment Steam drops, so the
    current price always equals it.
    """
    if not history or low.recorded_at is None:
        return RecordStatus.unknown()

    newest = max(history, key=lambda point: point.recorded_at)
    if newest.recorded_at != low.recorded_at:
        return RecordStatus(sets_new_record=False)

    earlier = [
        point.price
        for point in history
        if point.recorded_at < low.recorded_at and point.price.currency == low.low.currency
    ]
    return RecordStatus(sets_new_record=True, previous_low=min(earlier) if earlier else None)


def annotate_records(
    deals: Sequence[Deal], statuses: Mapping[int, RecordStatus]
) -> list[Deal]:
    """Attaches record status to each deal, leaving anything unknown alone."""
    return [
        replace(deal, record=statuses[deal.app_id]) if deal.app_id in statuses else deal
        for deal in deals
    ]


def record_setting_deals(deals: Sequence[Deal]) -> list[Deal]:
    """Only sales that beat every earlier price.

    An unknown status is dropped as well, since claiming a record would be
    invented; the failed history lookup is already logged by `ItadClient`.
    """
    return [deal for deal in deals if deal.record.sets_new_record]
