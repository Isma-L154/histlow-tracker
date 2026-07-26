"""The decision logic: which games qualify, and which are worth reporting.

Every function here is pure. No network, no clock, no filesystem. This is where
the project's actual rules live, so they are expressed as plain transformations
that a test can drive with three lines of setup.

The two filters correspond to the optimisation the whole design rests on:

1. `discounted_app_ids` reduces the wishlist to titles currently on sale,
   before any historical data is requested. This is what keeps the ITAD call
   small - for a typical wishlist it removes roughly three quarters of it.
2. `qualifying_deals` keeps only those priced at or below their all-time Steam
   low.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace

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


def discounted_app_ids(
    quotes: Mapping[int, PriceQuote], rules: AlertRules
) -> list[int]:
    """Returns the app ids currently discounted by at least the configured cut.

    Ordered for determinism so that a run's logs and requests are reproducible.
    """
    return sorted(
        app_id
        for app_id, quote in quotes.items()
        if quote.discount_percent >= rules.min_discount_percent
    )


class CurrencyMismatchError(RuntimeError):
    """Every comparison was impossible because the currencies disagree.

    Raised rather than returning an empty list, because an empty list is
    indistinguishable from "nothing is on sale" and would leave the tracker
    permanently, invisibly silent - the single failure mode this project exists
    to prevent.
    """


def qualifying_deals(
    store_quotes: Mapping[int, PriceQuote],
    reference_quotes: Mapping[int, PriceQuote],
    identities: Mapping[int, GameIdentity],
    lows: Mapping[int, HistoricalLow],
) -> list[Deal]:
    """Keeps only games priced at or below their all-time Steam low.

    The decision uses `reference_quotes` and `lows`, which share a currency
    ITAD actually tracks. Prices shown to the user come from `store_quotes`,
    in the currency they will really pay.

    A game missing an identity, a reference price or a recorded low is skipped
    rather than guessed at: with nothing to compare against, any answer would
    be invented.

    Matching the low counts as a hit. A sale that merely equals the best price
    ever seen is still the best price ever seen, and holding out for a strict
    improvement would suppress most genuine opportunities.
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


def rank_for_payload(deals: Sequence[Deal], rules: AlertRules) -> list[Deal]:
    """Orders deals by how notable they are and applies the payload cap.

    Deepest discount first. The cap exists so a storewide sale cannot produce
    an unreadable notification; the ordering ensures the truncated tail is the
    least interesting part.

    Record status is deliberately not a sort key here: it is not known until
    after ranking, because the history lookup runs only on the games that
    survive this cut.
    """
    ordered = sorted(
        deals,
        key=lambda deal: (-deal.discount_percent, deal.title.casefold()),
    )
    return ordered[: rules.max_items_in_payload]


def classify_record(
    history: Sequence[PricePoint], low: HistoricalLow
) -> RecordStatus:
    """Decides whether the current sale set the all-time low or merely met it.

    The test is exact rather than heuristic: ITAD stamps the recorded low and
    the corresponding history entry with the same instant, so the current price
    run is the record-setting one precisely when the newest history entry
    carries the low's timestamp.

    Comparing the current price against the recorded low cannot answer this.
    ITAD updates that low the moment Steam drops the price, so by the time the
    tracker reads it the two are always equal - which is why the previous
    version of this check could never report a new record at all.
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
    """Keeps only sales that beat every earlier price.

    A game returning to a record set by an earlier sale is dropped, even though
    it is genuinely at its all-time low right now.

    A deal whose history could not be loaded is dropped too, since its status
    is unknown and claiming a record would be a fabrication. That errs towards
    silence, which is the safe direction for a false-positive but not for a
    missed alert - so `pipeline` logs the distinction loudly.
    """
    return [deal for deal in deals if deal.record.sets_new_record]
