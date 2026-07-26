"""Tests for payload rendering and money formatting."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from histlow.domain import Deal, Money
from histlow.payload import PAYLOAD_VERSION, build_payload, format_money

GENERATED_AT = datetime(2026, 7, 25, 18, 0, tzinfo=UTC)
HEADLINE = "\U0001f4b8 {count} en minimo historico"


def deal(
    app_id: int = 1030300,
    title: str = "Hollow Knight: Silksong",
    current: int = 999,
    low: int = 999,
    discount: int = 50,
    currency: str = "EUR",
) -> Deal:
    return Deal(
        app_id=app_id,
        title=title,
        current=Money(current, currency),
        regular=Money(1999, currency),
        discount_percent=discount,
        historical_low=Money(low, currency),
        low_recorded_at=GENERATED_AT,
    )


class TestFormatMoney:
    @pytest.mark.parametrize(
        ("minor", "currency", "expected"),
        [
            (999, "EUR", "9,99 €"),
            (1450, "EUR", "14,50 €"),
            (2799, "EUR", "27,99 €"),
            (0, "EUR", "0,00 €"),
            (999, "USD", "$9.99"),
            (999, "GBP", "£9.99"),
            (999, "PLN", "9.99 PLN"),  # unknown currency falls back to the code
        ],
    )
    def test_regional_conventions(self, minor: int, currency: str, expected: str) -> None:
        assert format_money(Money(minor, currency)) == expected

    def test_thousands_are_grouped(self) -> None:
        assert format_money(Money(123456, "EUR")) == "1.234,56 €"
        assert format_money(Money(123456789, "USD")) == "$1,234,567.89"

    @pytest.mark.parametrize(
        ("minor", "expected"),
        [
            # Live Steam values for the Costa Rica storefront. Steam reports
            # colones in hundredths, but they are never written that way.
            (1500000, "₡15.000"),
            (864000, "₡8.640"),
            (2112000, "₡21.120"),
            (3750000, "₡37.500"),
            (0, "₡0"),
        ],
    )
    def test_colones_drop_the_unused_decimals(self, minor: int, expected: str) -> None:
        assert format_money(Money(minor, "CRC")) == expected

    def test_colones_keep_decimals_when_they_are_not_zero(self) -> None:
        assert format_money(Money(1500050, "CRC")) == "₡15.000,50"


class TestBuildPayload:
    def test_renders_a_single_deal(self) -> None:
        payload = build_payload(
            [deal()], generated_at=GENERATED_AT, headline_template=HEADLINE
        )

        assert payload["version"] == PAYLOAD_VERSION
        assert payload["count"] == 1
        assert payload["headline"] == "\U0001f4b8 1 en minimo historico"
        assert payload["summary"] == "Hollow Knight: Silksong 9,99 €"

        entry = payload["deals"][0]
        assert entry["title"] == "Hollow Knight: Silksong"
        assert entry["price"] == "9,99 €"
        assert entry["price_minor"] == 999
        assert entry["discount_percent"] == 50
        assert entry["url"].endswith("/app/1030300")

    def test_names_every_game_in_the_summary(self) -> None:
        # The whole point of the design: the notification says what is cheap,
        # not merely that something is.
        payload = build_payload(
            [deal(title="Silksong"), deal(app_id=2, title="Hades II")],
            generated_at=GENERATED_AT,
            headline_template=HEADLINE,
        )
        assert payload["summary"] == "Silksong 9,99 € · Hades II 9,99 €"

    def test_a_matched_low_is_not_flagged_as_a_record(self) -> None:
        payload = build_payload(
            [deal(current=999, low=999)], generated_at=GENERATED_AT, headline_template=HEADLINE
        )
        assert payload["deals"][0]["is_new_record"] is False

    def test_a_beaten_low_is_flagged_as_a_record(self) -> None:
        payload = build_payload(
            [deal(current=899, low=999)], generated_at=GENERATED_AT, headline_template=HEADLINE
        )
        assert payload["deals"][0]["is_new_record"] is True

    def test_an_empty_run_still_produces_a_valid_document(self) -> None:
        # The Shortcut must be able to distinguish "nothing on sale" from "the
        # tracker stopped running", which it does via generated_at.
        payload = build_payload([], generated_at=GENERATED_AT, headline_template=HEADLINE)

        assert payload["count"] == 0
        assert payload["summary"] == ""
        assert payload["deals"] == []
        assert payload["generated_at"] == GENERATED_AT.isoformat()

    def test_a_custom_separator_is_used(self) -> None:
        payload = build_payload(
            [deal(title="A"), deal(app_id=2, title="B")],
            generated_at=GENERATED_AT,
            headline_template=HEADLINE,
            separator=" | ",
        )
        assert payload["summary"] == "A 9,99 € | B 9,99 €"

    def test_missing_low_timestamp_is_serialised_as_null(self) -> None:
        bare = Deal(
            app_id=1,
            title="No timestamp",
            current=Money(999, "EUR"),
            regular=Money(1999, "EUR"),
            discount_percent=50,
            historical_low=Money(999, "EUR"),
            low_recorded_at=None,
        )
        payload = build_payload([bare], generated_at=GENERATED_AT, headline_template=HEADLINE)
        assert payload["deals"][0]["low_recorded_at"] is None

    def test_payload_is_json_serialisable(self) -> None:
        payload = build_payload([deal()], generated_at=GENERATED_AT, headline_template=HEADLINE)
        assert json.loads(json.dumps(payload)) == payload

    def test_order_is_preserved_from_the_caller(self) -> None:
        # Ranking is the selector's job; the renderer must not reorder.
        payload = build_payload(
            [deal(app_id=2, title="Second"), deal(app_id=1, title="First")],
            generated_at=GENERATED_AT,
            headline_template=HEADLINE,
        )
        assert [d["title"] for d in payload["deals"]] == ["Second", "First"]
