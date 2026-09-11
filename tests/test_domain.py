"""Tests for the value objects, with emphasis on money safety."""

from __future__ import annotations

import pytest

from histlow.domain import Deal, DomainError, Money, PriceQuote


class TestMoney:
    def test_rejects_negative_amounts(self) -> None:
        with pytest.raises(DomainError, match="negative"):
            Money(-1, "EUR")

    @pytest.mark.parametrize("currency", ["EU", "EURO", "eur", "E1R"])
    def test_rejects_malformed_currency(self, currency: str) -> None:
        with pytest.raises(DomainError):
            Money(999, currency)

    def test_comparison_across_currencies_raises_instead_of_lying(self) -> None:
        with pytest.raises(DomainError, match="refusing to compare"):
            _ = Money(999, "EUR") <= Money(999, "USD")

    def test_equal_amounts_satisfy_at_or_below(self) -> None:
        # The core predicate of the whole tracker: matching the all-time low
        # counts as a hit, not just beating it.
        assert Money(1499, "EUR") <= Money(1499, "EUR")

    def test_ordering_is_consistent(self) -> None:
        cheap, dear = Money(999, "EUR"), Money(1999, "EUR")
        assert cheap < dear
        assert dear > cheap
        assert cheap <= dear
        assert dear >= cheap
        assert not dear < cheap

    def test_is_hashable_and_value_compared(self) -> None:
        assert Money(999, "EUR") == Money(999, "EUR")
        assert len({Money(999, "EUR"), Money(999, "EUR")}) == 1


class TestPriceQuote:
    def test_rejects_mixed_currencies(self) -> None:
        with pytest.raises(DomainError):
            PriceQuote(
                app_id=1,
                current=Money(999, "EUR"),
                regular=Money(1999, "USD"),
                discount_percent=50,
            )

    def test_rejects_out_of_range_discount(self) -> None:
        with pytest.raises(DomainError, match="discount out of range"):
            PriceQuote(
                app_id=1,
                current=Money(999, "EUR"),
                regular=Money(1999, "EUR"),
                discount_percent=101,
            )


class TestDeal:
    def _deal(self, current: int, low: int) -> Deal:
        return Deal(
            app_id=1030300,
            title="Hollow Knight: Silksong",
            current=Money(current, "EUR"),
            regular=Money(1999, "EUR"),
            discount_percent=50,
            reference_current=Money(current, "EUR"),
            reference_low=Money(low, "EUR"),
            low_recorded_at=None,
        )

    def test_record_status_defaults_to_claiming_nothing(self) -> None:
        # Whether a sale set the record needs price history, which the Deal
        # does not have. Deciding it lives in selector.classify_record.
        assert self._deal(999, 999).record.sets_new_record is False

    def test_store_url_points_at_the_app(self) -> None:
        assert self._deal(999, 999).store_url.endswith("/app/1030300")

    def test_same_region_is_not_flagged_as_cross_region(self) -> None:
        assert not self._deal(999, 999).is_cross_region

    def test_a_cross_region_comparison_is_flagged(self) -> None:
        # The Costa Rica case: paid in colones, decided in dollars.
        deal = Deal(
            app_id=1,
            title="Cross region",
            current=Money(1500000, "CRC"),
            regular=Money(3750000, "CRC"),
            discount_percent=60,
            reference_current=Money(2799, "USD"),
            reference_low=Money(2799, "USD"),
            low_recorded_at=None,
        )
        assert deal.is_cross_region

    def test_display_currencies_must_agree_with_each_other(self) -> None:
        with pytest.raises(DomainError):
            Deal(
                app_id=1,
                title="Bad",
                current=Money(999, "EUR"),
                regular=Money(1999, "USD"),
                discount_percent=50,
                reference_current=Money(999, "USD"),
                reference_low=Money(999, "USD"),
                low_recorded_at=None,
            )

    def test_reference_currencies_must_agree_with_each_other(self) -> None:
        with pytest.raises(DomainError):
            Deal(
                app_id=1,
                title="Bad",
                current=Money(999, "EUR"),
                regular=Money(1999, "EUR"),
                discount_percent=50,
                reference_current=Money(999, "USD"),
                reference_low=Money(999, "GBP"),
                low_recorded_at=None,
            )
