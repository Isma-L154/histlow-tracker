"""Decides whether a cron firing does real work: a guard against doing it twice."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import ScheduleConfig

#: Lets a firing that lands just short of the interval still run.
DRIFT_GRACE = timedelta(minutes=20)


@dataclass(frozen=True, slots=True)
class RunDecision:
    should_run: bool
    reason: str


def decide(
    *,
    now: datetime,
    schedule: ScheduleConfig,
    last_run_at: datetime | None,
    forced: bool = False,
) -> RunDecision:
    if forced:
        return RunDecision(True, "manual dispatch")

    if last_run_at is None:
        return RunDecision(True, "no previous run recorded")

    elapsed = now - last_run_at
    if elapsed < timedelta(0):
        # A future timestamp means a wrong clock or state file; running at worst repeats work.
        return RunDecision(True, "recorded last run is in the future")

    interval = timedelta(hours=schedule.min_interval_hours)
    if elapsed + DRIFT_GRACE >= interval:
        return RunDecision(True, f"{_format(elapsed)} since last run")

    return RunDecision(
        False,
        f"only {_format(elapsed)} since last run, minimum is {schedule.min_interval_hours}h",
    )


def _format(delta: timedelta) -> str:
    hours, remainder = divmod(int(delta.total_seconds()), 3600)
    return f"{hours}h{remainder // 60:02d}m"
