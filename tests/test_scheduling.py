"""Tests for the cron gate."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from histlow.config import SaleWindow, ScheduleConfig
from histlow.scheduling import DRIFT_GRACE, MIN_DAILY_GAP, STALE_AFTER, decide

WINTER = SaleWindow("Winter Sale", date(2026, 12, 18), date(2027, 1, 5), interval_hours=3)
SCHEDULE = ScheduleConfig(daily_run_hours_utc=(18,), sale_windows=(WINTER,))

QUIET_DAY = datetime(2026, 7, 25, 18, 5, tzinfo=UTC)
SALE_DAY = datetime(2026, 12, 20, 12, 5, tzinfo=UTC)


def at(moment: datetime, **shift: float) -> datetime:
    return moment - timedelta(**shift)


class TestForcedAndFirstRun:
    def test_manual_dispatch_always_runs(self) -> None:
        decision = decide(
            now=QUIET_DAY, schedule=SCHEDULE, last_run_at=at(QUIET_DAY, minutes=1), forced=True
        )
        assert decision.should_run
        assert "manual" in decision.reason

    def test_the_very_first_run_proceeds(self) -> None:
        assert decide(now=QUIET_DAY, schedule=SCHEDULE, last_run_at=None).should_run

    def test_a_future_timestamp_is_treated_as_corrupt_and_runs(self) -> None:
        # Wrong clock or wrong state file. Running repeats work at worst;
        # refusing could stall the tracker indefinitely.
        future = QUIET_DAY + timedelta(days=1)
        assert decide(now=QUIET_DAY, schedule=SCHEDULE, last_run_at=future).should_run


class TestOutsideSaleWindows:
    def test_runs_in_the_configured_daily_slot(self) -> None:
        decision = decide(
            now=QUIET_DAY, schedule=SCHEDULE, last_run_at=at(QUIET_DAY, hours=24)
        )
        assert decision.should_run
        assert "daily slot 18:00" in decision.reason

    def test_skips_outside_the_daily_slot(self) -> None:
        midday = QUIET_DAY.replace(hour=12)
        decision = decide(now=midday, schedule=SCHEDULE, last_run_at=at(midday, hours=21))
        assert not decision.should_run

    def test_a_second_firing_in_the_same_slot_is_suppressed(self) -> None:
        decision = decide(
            now=QUIET_DAY, schedule=SCHEDULE, last_run_at=at(QUIET_DAY, minutes=30)
        )
        assert not decision.should_run

    def test_catch_up_runs_after_a_missed_slot(self) -> None:
        # A dropped cron must not cost a whole extra day of silence.
        midday = QUIET_DAY.replace(hour=12)
        decision = decide(
            now=midday, schedule=SCHEDULE, last_run_at=midday - STALE_AFTER - timedelta(minutes=1)
        )
        assert decision.should_run
        assert "catch-up" in decision.reason

    def test_the_daily_gap_guard_is_respected(self) -> None:
        just_short = QUIET_DAY - MIN_DAILY_GAP + timedelta(minutes=1)
        assert not decide(now=QUIET_DAY, schedule=SCHEDULE, last_run_at=just_short).should_run

        just_over = QUIET_DAY - MIN_DAILY_GAP
        assert decide(now=QUIET_DAY, schedule=SCHEDULE, last_run_at=just_over).should_run


class TestInsideSaleWindows:
    def test_runs_on_the_sale_cadence(self) -> None:
        decision = decide(now=SALE_DAY, schedule=SCHEDULE, last_run_at=at(SALE_DAY, hours=3))
        assert decision.should_run
        assert decision.window_name == "Winter Sale"

    def test_skips_between_sale_slots(self) -> None:
        decision = decide(now=SALE_DAY, schedule=SCHEDULE, last_run_at=at(SALE_DAY, minutes=30))
        assert not decision.should_run
        assert decision.window_name == "Winter Sale"

    def test_drift_grace_absorbs_an_early_firing(self) -> None:
        # GitHub fires a few minutes early or late; without the grace the
        # cadence would slip by a full slot each time.
        slightly_early = SALE_DAY - timedelta(hours=3) + DRIFT_GRACE
        assert decide(now=SALE_DAY, schedule=SCHEDULE, last_run_at=slightly_early).should_run

    def test_the_sale_cadence_ignores_the_daily_hour_anchor(self) -> None:
        # 12:05 is nowhere near the configured 18:00 daily slot, yet a sale is
        # active, so the interval alone governs.
        assert SALE_DAY.hour not in SCHEDULE.daily_run_hours_utc
        assert decide(now=SALE_DAY, schedule=SCHEDULE, last_run_at=at(SALE_DAY, hours=4)).should_run

    def test_the_window_boundary_switches_cadence(self) -> None:
        day_before = datetime(2026, 12, 17, 12, 5, tzinfo=UTC)
        decision = decide(
            now=day_before, schedule=SCHEDULE, last_run_at=at(day_before, hours=4)
        )
        assert not decision.should_run
        assert decision.window_name is None
