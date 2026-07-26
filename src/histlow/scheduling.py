"""Decides whether a given cron firing should do real work.

GitHub Actions cron expressions are static, so the workflow fires on one fixed
frequent cadence and this module gates it. Changing how often the tracker runs
is therefore a `config.json` edit, never a YAML edit.

The gate keys off elapsed time since the last real run rather than matching the
clock exactly. GitHub routinely delays scheduled runs by minutes and
occasionally drops one entirely; an exact hour match would silently skip a day
each time that happened.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import ScheduleConfig

#: Absorbs GitHub's scheduling drift. Without it a run arriving 2 minutes shy
#: of the interval would be skipped, pushing the real cadence out by a full
#: cron slot every time.
DRIFT_GRACE = timedelta(minutes=20)

#: Outside a sale window the daily run is anchored to a configured hour, and
#: this guard stops two firings within that same hour from both proceeding.
MIN_DAILY_GAP = timedelta(hours=20)

#: Upper bound on silence. If the anchored hour is missed - a dropped cron, a
#: long outage - the next firing runs anyway rather than waiting another day.
STALE_AFTER = timedelta(hours=26)


@dataclass(frozen=True, slots=True)
class RunDecision:
    """Whether to proceed, and the reason, which is logged either way."""

    should_run: bool
    reason: str
    window_name: str | None = None


def decide(
    *,
    now: datetime,
    schedule: ScheduleConfig,
    last_run_at: datetime | None,
    forced: bool = False,
) -> RunDecision:
    """Returns the run decision for this firing."""
    if forced:
        return RunDecision(True, "manual dispatch")

    if last_run_at is None:
        return RunDecision(True, "no previous run recorded")

    elapsed = now - last_run_at
    if elapsed < timedelta(0):
        # The stored timestamp is in the future, so the clock or the state file
        # is wrong. Running is the safe direction: at worst it repeats work.
        return RunDecision(True, "recorded last run is in the future")

    window = schedule.active_window(now.date())
    if window is not None:
        interval = timedelta(hours=window.interval_hours)
        if elapsed + DRIFT_GRACE >= interval:
            return RunDecision(True, f"sale cadence every {window.interval_hours}h", window.name)
        return RunDecision(
            False,
            f"{_format(elapsed)} since last run, sale cadence is {window.interval_hours}h",
            window.name,
        )

    if elapsed >= STALE_AFTER:
        return RunDecision(True, f"catch-up, {_format(elapsed)} since last run")

    if now.hour in schedule.daily_run_hours_utc and elapsed >= MIN_DAILY_GAP:
        return RunDecision(True, f"daily slot {now.hour:02d}:00 UTC")

    return RunDecision(False, f"{_format(elapsed)} since last run, outside the daily slot")


def _format(delta: timedelta) -> str:
    hours, remainder = divmod(int(delta.total_seconds()), 3600)
    return f"{hours}h{remainder // 60:02d}m"
