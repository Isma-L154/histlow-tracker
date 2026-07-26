"""Tests for telling a newly set record apart from a matched one.

Fixtures mirror real ITAD history, verified live against three games:

* SILENT HILL 2 dropped to $27.99 on 2026-07-14, beating $34.99. Its recorded
  low carries that same instant, so this sale set the record.
* Dispatch sits at $23.99 today, but its recorded low is stamped 2026-03-19
  while the newest history entry is 2026-07-20. It is matching an older record.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from helpers import make_deal
from histlow.domain import HistoricalLow, Money, PricePoint, RecordStatus
from histlow.selector import annotate_records, classify_record, record_setting_deals

JULY_14 = datetime(2026, 7, 14, 19, 16, 38, tzinfo=UTC)
JULY_20 = datetime(2026, 7, 20, 19, 27, 57, tzinfo=UTC)
MARCH_19 = datetime(2026, 3, 19, 18, 29, 43, tzinfo=UTC)


def point(amount: int, when: datetime, currency: str = "USD") -> PricePoint:
    return PricePoint(price=Money(amount, currency), recorded_at=when)


def low(amount: int, when: datetime | None, currency: str = "USD") -> HistoricalLow:
    return HistoricalLow(app_id=1, low=Money(amount, currency), recorded_at=when)


class TestClassifyRecord:
    def test_the_current_sale_setting_the_record_is_a_new_low(self) -> None:
        # SILENT HILL 2: the newest entry carries the low's exact timestamp.
        history = [
            point(2799, JULY_14),
            point(6999, datetime(2026, 7, 9, tzinfo=UTC)),
            point(3499, datetime(2026, 6, 25, tzinfo=UTC)),
            point(6999, datetime(2026, 5, 5, tzinfo=UTC)),
            point(3499, datetime(2026, 4, 24, tzinfo=UTC)),
        ]

        status = classify_record(history, low(2799, JULY_14))

        assert status.sets_new_record
        assert status.previous_low == Money(3499, "USD")

    def test_returning_to_an_older_record_is_not_a_new_low(self) -> None:
        # Dispatch: priced at the record again, but the record is from March.
        history = [point(2399, JULY_20), point(2999, datetime(2026, 5, 1, tzinfo=UTC))]

        status = classify_record(history, low(2399, MARCH_19))

        assert not status.sets_new_record
        assert status.previous_low is None

    def test_the_comparison_is_on_the_instant_not_the_day(self) -> None:
        history = [point(2799, JULY_14)]
        one_second_off = JULY_14 + timedelta(seconds=1)

        assert not classify_record(history, low(2799, one_second_off)).sets_new_record

    def test_a_first_ever_discount_reports_no_previous_low(self) -> None:
        history = [point(2799, JULY_14)]
        status = classify_record(history, low(2799, JULY_14))

        assert status.sets_new_record
        assert status.previous_low is None

    def test_the_lowest_earlier_price_is_chosen_not_the_most_recent(self) -> None:
        history = [
            point(2799, JULY_14),
            point(5999, datetime(2026, 7, 1, tzinfo=UTC)),
            point(3199, datetime(2026, 2, 1, tzinfo=UTC)),
            point(4999, datetime(2026, 1, 1, tzinfo=UTC)),
        ]
        assert classify_record(history, low(2799, JULY_14)).previous_low == Money(3199, "USD")

    def test_entries_in_another_currency_are_excluded_from_the_previous_low(self) -> None:
        history = [
            point(2799, JULY_14),
            point(199, datetime(2026, 2, 1, tzinfo=UTC), currency="EUR"),
            point(3499, datetime(2026, 1, 1, tzinfo=UTC)),
        ]
        assert classify_record(history, low(2799, JULY_14)).previous_low == Money(3499, "USD")

    def test_unsorted_history_is_handled(self) -> None:
        history = [point(3499, datetime(2026, 4, 24, tzinfo=UTC)), point(2799, JULY_14)]
        assert classify_record(history, low(2799, JULY_14)).sets_new_record

    def test_empty_history_claims_nothing(self) -> None:
        # A failed history lookup must never invent a record.
        assert classify_record([], low(2799, JULY_14)) == RecordStatus.unknown()

    def test_a_low_without_a_timestamp_claims_nothing(self) -> None:
        assert classify_record([point(2799, JULY_14)], low(2799, None)).sets_new_record is False


class TestRecordSettingDeals:
    """The alert rule: only sales that beat the previous record are reported."""

    def test_keeps_a_record_breaker(self) -> None:
        deal = make_deal(app_id=1, record=RecordStatus(True, Money(3499, "EUR")))
        assert record_setting_deals([deal]) == [deal]

    def test_drops_a_game_merely_matching_its_record(self) -> None:
        # Dispatch's case: genuinely at its all-time low, but it did not go
        # lower than the record set in March.
        matching = make_deal(app_id=2, record=RecordStatus(sets_new_record=False))
        assert record_setting_deals([matching]) == []

    def test_drops_a_game_whose_history_could_not_be_loaded(self) -> None:
        # Unknown must never be treated as a record; that would fabricate one.
        assert record_setting_deals([make_deal(app_id=3)]) == []

    def test_a_first_ever_discount_counts_as_beating_the_record(self) -> None:
        first = make_deal(app_id=4, record=RecordStatus(sets_new_record=True))
        assert record_setting_deals([first]) == [first]

    def test_filters_a_mixed_set(self) -> None:
        breaker = make_deal(app_id=1, title="Beat it", record=RecordStatus(True))
        matcher = make_deal(app_id=2, title="Matched", record=RecordStatus(False))
        unknown = make_deal(app_id=3, title="Unknown")

        kept = record_setting_deals([breaker, matcher, unknown])
        assert [d.title for d in kept] == ["Beat it"]

    def test_order_is_preserved(self) -> None:
        deals = [make_deal(app_id=i, record=RecordStatus(True)) for i in (3, 1, 2)]
        assert [d.app_id for d in record_setting_deals(deals)] == [3, 1, 2]

    def test_empty_input(self) -> None:
        assert record_setting_deals([]) == []


class TestAnnotateRecords:
    def test_attaches_status_by_app_id(self) -> None:
        deals = [make_deal(app_id=1), make_deal(app_id=2)]
        statuses = {1: RecordStatus(sets_new_record=True, previous_low=Money(3499, "EUR"))}

        annotated = annotate_records(deals, statuses)

        assert annotated[0].record.sets_new_record
        assert annotated[1].record.sets_new_record is False

    def test_leaves_the_originals_untouched(self) -> None:
        deals = [make_deal(app_id=1)]
        annotate_records(deals, {1: RecordStatus(sets_new_record=True)})
        assert deals[0].record.sets_new_record is False

    def test_an_empty_status_map_changes_nothing(self) -> None:
        deals = [make_deal(app_id=1)]
        assert annotate_records(deals, {})[0].record == RecordStatus.unknown()
