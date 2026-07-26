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

from .config import AlertRules
from .domain import Deal, DomainError, GameIdentity, HistoricalLow, PriceQuote
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

    A price that beats the previous record leads, then the deepest discounts.
    The cap exists so a storewide sale cannot produce an unreadable
    notification; the ordering ensures the truncated tail is the least
    interesting part.
    """
    ordered = sorted(
        deals,
        key=lambda deal: (
            not deal.beats_previous_low,
            -deal.discount_percent,
            deal.title.casefold(),
        ),
    )
    return ordered[: rules.max_items_in_payload]
