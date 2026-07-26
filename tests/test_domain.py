"""Tests for the value objects, with emphasis on money safety."""

from __future__ import annotations

import pytest

from histlow.domain import Deal, DomainError, Money, StorePrice


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

    def test_string_rendering_pads_cents(self) -> None:
        assert str(Money(1405, "EUR")) == "14.05 EUR"
        assert str(Money(1450, "EUR")) == "14.50 EUR"
        assert str(Money(0, "EUR")) == "0.00 EUR"

    def test_is_hashable_and_value_compared(self) -> None:
        assert Money(999, "EUR") == Money(999, "EUR")
        assert len({Money(999, "EUR"), Money(999, "EUR")}) == 1


class TestStorePrice:
    def test_rejects_mixed_currencies(self) -> None:
        with pytest.raises(DomainError):
            StorePrice(
                app_id=1,
                title="Mixed",
                current=Money(999, "EUR"),
                regular=Money(1999, "USD"),
                discount_percent=50,
            )

    def test_rejects_out_of_range_discount(self) -> None:
        with pytest.raises(DomainError, match="discount out of range"):
            StorePrice(
                app_id=1,
                title="Bad",
                current=Money(999, "EUR"),
                regular=Money(1999, "EUR"),
                discount_percent=101,
            )

    def test_is_discounted_reflects_percentage(self) -> None:
        full = StorePrice(1, "Full", Money(1999, "EUR"), Money(1999, "EUR"), 0)
        cut = StorePrice(2, "Cut", Money(999, "EUR"), Money(1999, "EUR"), 50)
        assert not full.is_discounted
        assert cut.is_discounted


class TestDeal:
    def _deal(self, current: int, low: int) -> Deal:
        return Deal(
            app_id=1030300,
            title="Hollow Knight: Silksong",
            current=Money(current, "EUR"),
            regular=Money(1999, "EUR"),
            discount_percent=50,
            historical_low=Money(low, "EUR"),
            low_recorded_at=None,
        )

    def test_matching_the_low_is_not_a_new_record(self) -> None:
        assert not self._deal(999, 999).beats_previous_low

    def test_undercutting_the_low_is_a_new_record(self) -> None:
        assert self._deal(899, 999).beats_previous_low

    def test_store_url_points_at_the_app(self) -> None:
        assert self._deal(999, 999).store_url.endswith("/app/1030300")
