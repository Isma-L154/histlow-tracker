"""Tests for the decision logic.

This is the core of the project: the rules that decide whether the user's phone
buzzes. Every case here is a plain data transformation with no I/O.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from histlow.config import AlertRules
from histlow.domain import GameIdentity, HistoricalLow, Money, PriceQuote
from histlow.selector import (
    CurrencyMismatchError,
    discounted_app_ids,
    qualifying_deals,
    rank_for_payload,
    unreported_deals,
)
from histlow.state import TrackerState

NOW = datetime(2026, 7, 25, 18, 0, tzinfo=UTC)
RULES = AlertRules()


def quote(app_id: int, current: int, regular: int, discount: int, currency: str = "EUR"):
    return PriceQuote(
        app_id=app_id,
        current=Money(current, currency),
        regular=Money(regular, currency),
        discount_percent=discount,
    )


def identity(app_id: int, title: str = "A Game") -> GameIdentity:
    return GameIdentity(app_id=app_id, itad_id=f"uuid-{app_id}", title=title)


def low(app_id: int, amount: int, currency: str = "EUR") -> HistoricalLow:
    return HistoricalLow(app_id=app_id, low=Money(amount, currency), recorded_at=NOW)


def same_region(quotes):
    """Most cases run one region, where store and reference prices coincide."""
    return quotes, quotes


# ---------------------------------------------------------------------------
# Step 2: discount filter
# ---------------------------------------------------------------------------


class TestDiscountedAppIds:
    def test_keeps_only_discounted_titles(self) -> None:
        quotes = {
            1: quote(1, 2799, 6999, 60),
            2: quote(2, 5999, 5999, 0),
            3: quote(3, 2319, 2899, 20),
        }
        assert discounted_app_ids(quotes, RULES) == [1, 3]

    def test_respects_a_minimum_discount_threshold(self) -> None:
        quotes = {1: quote(1, 2799, 6999, 60), 2: quote(2, 2799, 2899, 5)}
        assert discounted_app_ids(quotes, AlertRules(min_discount_percent=50)) == [1]

    def test_result_is_deterministically_ordered(self) -> None:
        quotes = {9: quote(9, 1, 2, 50), 3: quote(3, 1, 2, 50), 7: quote(7, 1, 2, 50)}
        assert discounted_app_ids(quotes, RULES) == [3, 7, 9]

    def test_empty_input_yields_nothing(self) -> None:
        assert discounted_app_ids({}, RULES) == []


# ---------------------------------------------------------------------------
# Step 4: historical-low comparison
# ---------------------------------------------------------------------------


class TestQualifyingDeals:
    def test_matching_the_all_time_low_qualifies(self) -> None:
        # The central rule: equalling the record still counts. Most alerts are
        # of this kind, since ITAD records a new low the moment it happens.
        deals = qualifying_deals(
            *same_region({1: quote(1, 999, 1999, 50)}), {1: identity(1)}, {1: low(1, 999)}
        )
        assert [d.app_id for d in deals] == [1]

    def test_undercutting_the_all_time_low_qualifies(self) -> None:
        deals = qualifying_deals(
            *same_region({1: quote(1, 899, 1999, 55)}), {1: identity(1)}, {1: low(1, 999)}
        )
        assert [d.app_id for d in deals] == [1]

    def test_a_price_above_the_low_does_not_qualify(self) -> None:
        assert (
            qualifying_deals(
                *same_region({1: quote(1, 1099, 1999, 45)}), {1: identity(1)}, {1: low(1, 999)}
            )
            == []
        )

    def test_one_cent_above_the_low_does_not_qualify(self) -> None:
        # Exercises the integer comparison at its boundary.
        assert (
            qualifying_deals(
                *same_region({1: quote(1, 1000, 1999, 50)}), {1: identity(1)}, {1: low(1, 999)}
            )
            == []
        )

    def test_game_without_a_recorded_low_is_skipped(self) -> None:
        quotes = same_region({1: quote(1, 999, 1999, 50)})
        assert qualifying_deals(*quotes, {1: identity(1)}, {}) == []

    def test_game_without_an_identity_is_skipped(self) -> None:
        quotes = same_region({1: quote(1, 999, 1999, 50)})
        assert qualifying_deals(*quotes, {}, {1: low(1, 999)}) == []

    def test_game_without_a_reference_price_is_skipped(self) -> None:
        assert (
            qualifying_deals(
                {1: quote(1, 999, 1999, 50)}, {}, {1: identity(1)}, {1: low(1, 999)}
            )
            == []
        )

    def test_carries_the_title_through_from_the_identity(self) -> None:
        deals = qualifying_deals(
            *same_region({1: quote(1, 999, 1999, 50)}),
            {1: identity(1, "Silksong")},
            {1: low(1, 999)},
        )
        assert deals[0].title == "Silksong"

    def test_mixed_batch_keeps_only_the_qualifying_entries(self) -> None:
        quotes = {
            1: quote(1, 999, 1999, 50),
            2: quote(2, 1500, 2000, 25),
            3: quote(3, 500, 2000, 75),
        }
        identities = {1: identity(1), 2: identity(2), 3: identity(3)}
        lows = {1: low(1, 999), 2: low(2, 1000), 3: low(3, 600)}

        deals = qualifying_deals(*same_region(quotes), identities, lows)
        assert [d.app_id for d in deals] == [1, 3]


class TestCrossRegionComparison:
    """The Costa Rica case: ITAD reports CRC storefronts in USD."""

    def test_decides_on_the_reference_region_but_shows_the_store_price(self) -> None:
        store = {1: quote(1, 1500000, 3750000, 60, currency="CRC")}
        reference = {1: quote(1, 2799, 6999, 60, currency="USD")}

        deals = qualifying_deals(
            store, reference, {1: identity(1, "SILENT HILL 2")}, {1: low(1, 2799, "USD")}
        )

        assert len(deals) == 1
        assert deals[0].current == Money(1500000, "CRC")  # what the user pays
        assert deals[0].reference_low == Money(2799, "USD")  # what decided it
        assert deals[0].is_cross_region

    def test_the_reference_price_governs_not_the_store_price(self) -> None:
        # Store price is numerically far below the low; only the currency-
        # matched pair may decide anything.
        store = {1: quote(1, 1500000, 3750000, 60, currency="CRC")}
        reference = {1: quote(1, 3999, 6999, 43, currency="USD")}

        assert qualifying_deals(store, reference, {1: identity(1)}, {1: low(1, 2799, "USD")}) == []

    def test_a_total_currency_mismatch_raises_instead_of_returning_empty(self) -> None:
        # This is the bug that made the tracker silent for Costa Rica: an empty
        # list is indistinguishable from "nothing is on sale".
        quotes = {1: quote(1, 1500000, 3750000, 60, currency="CRC")}

        with pytest.raises(CurrencyMismatchError, match="COMPARISON_COUNTRY"):
            qualifying_deals(quotes, quotes, {1: identity(1)}, {1: low(1, 2799, "USD")})

    def test_a_partial_mismatch_does_not_raise(self) -> None:
        # One odd game must not abort a run that is otherwise working.
        store = {1: quote(1, 999, 1999, 50), 2: quote(2, 999, 1999, 50)}
        lows = {1: low(1, 999, "EUR"), 2: low(2, 999, "USD")}

        deals = qualifying_deals(store, store, {1: identity(1), 2: identity(2)}, lows)
        assert [d.app_id for d in deals] == [1]

    def test_no_candidates_at_all_does_not_raise(self) -> None:
        assert qualifying_deals({}, {}, {}, {}) == []


# ---------------------------------------------------------------------------
# Anti-spam
# ---------------------------------------------------------------------------


class TestUnreportedDeals:
    @pytest.fixture
    def state(self, tmp_path: Path) -> TrackerState:
        return TrackerState.load(tmp_path / "state.json")

    def _deal(self, current: int):
        return qualifying_deals(
            *same_region({1: quote(1, current, 1999, 50)}), {1: identity(1)}, {1: low(1, 1999)}
        )

    def test_a_new_game_is_reported(self, state: TrackerState) -> None:
        assert len(unreported_deals(self._deal(999), state, RULES)) == 1

    def test_the_same_price_is_suppressed(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert unreported_deals(self._deal(999), state, RULES) == []

    def test_a_higher_price_is_suppressed(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert unreported_deals(self._deal(1099), state, RULES) == []

    def test_a_lower_price_is_reported_again(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert len(unreported_deals(self._deal(899), state, RULES)) == 1

    def test_a_drop_below_the_threshold_is_suppressed(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        rules = AlertRules(reprice_threshold_minor=100)
        assert unreported_deals(self._deal(950), state, rules) == []
        assert len(unreported_deals(self._deal(899), state, rules)) == 1


# ---------------------------------------------------------------------------
# Ordering and truncation
# ---------------------------------------------------------------------------


class TestRankForPayload:
    def _deal(self, app_id: int, current: int, low_amount: int, discount: int, title: str):
        return qualifying_deals(
            *same_region({app_id: quote(app_id, current, 9999, discount)}),
            {app_id: identity(app_id, title)},
            {app_id: low(app_id, low_amount)},
        )[0]

    def test_deeper_discounts_come_first(self) -> None:
        small = self._deal(1, 999, 999, 20, "Small")
        large = self._deal(2, 999, 999, 80, "Large")

        assert [d.title for d in rank_for_payload([small, large], RULES)] == ["Large", "Small"]

    def test_ties_break_alphabetically_for_stability(self) -> None:
        beta = self._deal(1, 999, 999, 50, "beta")
        alpha = self._deal(2, 999, 999, 50, "Alpha")

        assert [d.title for d in rank_for_payload([beta, alpha], RULES)] == ["Alpha", "beta"]

    def test_payload_is_capped(self) -> None:
        deals = [self._deal(i, 999, 999, 50, f"Game {i:02d}") for i in range(10)]
        assert len(rank_for_payload(deals, AlertRules(max_items_in_payload=3))) == 3

    def test_the_cap_keeps_the_deepest_discounts(self) -> None:
        deals = [
            self._deal(1, 999, 999, 10, "Shallow"),
            self._deal(2, 999, 999, 90, "Deepest"),
            self._deal(3, 999, 999, 45, "Middling"),
        ]
        kept = rank_for_payload(deals, AlertRules(max_items_in_payload=2))
        assert [d.title for d in kept] == ["Deepest", "Middling"]

    def test_empty_input_is_handled(self) -> None:
        assert rank_for_payload([], RULES) == []
