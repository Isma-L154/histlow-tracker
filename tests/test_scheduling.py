"""Tests for the cron gate.

The gate exists only to stop the same work happening twice. There is no
seasonal schedule: every firing does real work, all year round.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from histlow.config import ScheduleConfig
from histlow.scheduling import DRIFT_GRACE, decide

SCHEDULE = ScheduleConfig(min_interval_hours=3)
NOW = datetime(2026, 7, 26, 12, 5, tzinfo=UTC)


def ago(**shift: float) -> datetime:
    return NOW - timedelta(**shift)


class TestAlwaysRuns:
    def test_the_very_first_run_proceeds(self) -> None:
        assert decide(now=NOW, schedule=SCHEDULE, last_run_at=None).should_run

    def test_manual_dispatch_bypasses_the_interval(self) -> None:
        decision = decide(
            now=NOW, schedule=SCHEDULE, last_run_at=ago(minutes=1), forced=True
        )
        assert decision.should_run
        assert "manual" in decision.reason

    def test_a_future_timestamp_is_treated_as_corrupt_and_runs(self) -> None:
        # Wrong clock or wrong state file. Running repeats work at worst;
        # refusing could stall the tracker indefinitely.
        future = NOW + timedelta(days=1)
        assert decide(now=NOW, schedule=SCHEDULE, last_run_at=future).should_run


class TestInterval:
    def test_runs_once_the_interval_has_elapsed(self) -> None:
        assert decide(now=NOW, schedule=SCHEDULE, last_run_at=ago(hours=3)).should_run

    def test_skips_a_firing_inside_the_interval(self) -> None:
        decision = decide(now=NOW, schedule=SCHEDULE, last_run_at=ago(minutes=30))
        assert not decision.should_run
        assert "minimum is 3h" in decision.reason

    def test_drift_grace_absorbs_an_early_firing(self) -> None:
        # GitHub fires a few minutes early or late; without the grace the
        # cadence would slip by a full slot each time it happened.
        slightly_early = ago(hours=3) + DRIFT_GRACE
        assert decide(now=NOW, schedule=SCHEDULE, last_run_at=slightly_early).should_run

    def test_a_firing_just_outside_the_grace_is_skipped(self) -> None:
        too_early = ago(hours=3) + DRIFT_GRACE + timedelta(minutes=1)
        assert not decide(now=NOW, schedule=SCHEDULE, last_run_at=too_early).should_run

    def test_the_hour_of_day_is_irrelevant(self) -> None:
        # No daily anchor exists any more: an ordinary weekday discount is
        # picked up as promptly as one during a seasonal sale.
        for hour in (0, 4, 11, 17, 23):
            moment = NOW.replace(hour=hour)
            assert decide(
                now=moment, schedule=SCHEDULE, last_run_at=moment - timedelta(hours=3)
            ).should_run

    def test_a_longer_configured_interval_is_respected(self) -> None:
        slow = ScheduleConfig(min_interval_hours=12)
        assert not decide(now=NOW, schedule=slow, last_run_at=ago(hours=6)).should_run
        assert decide(now=NOW, schedule=slow, last_run_at=ago(hours=12)).should_run
