"""Decides whether a given cron firing should do real work.

The workflow fires every few hours and every firing does real work. There is no
seasonal schedule, and that is a deliberate simplification.

An earlier design ran once a day normally and escalated to every three hours
during hand-maintained sale windows. It had two problems. The dates had to be
kept current by hand, since no official Steam API publishes them and the one
site that tracks them accurately is off limits. Worse, it optimised the wrong
thing: a discount appearing on an ordinary Tuesday would wait up to a day,
which is the case the tracker exists for.

Running always costs about 240 billed minutes a month against a 2000-minute
free tier, and roughly thirteen HTTP requests per run. Paying that removes an
entire class of maintenance and cuts worst-case latency from a day to hours.

What remains is a single guard against doing the same work twice, which the
elapsed-time check below provides.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import ScheduleConfig

#: Absorbs GitHub's scheduling drift. Scheduled runs are routinely a few
#: minutes late and occasionally early; without this, a firing arriving just
#: shy of the interval would be skipped and the real cadence would slip by a
#: whole cron slot every time it happened.
DRIFT_GRACE = timedelta(minutes=20)


@dataclass(frozen=True, slots=True)
class RunDecision:
    """Whether to proceed, and the reason, which is logged either way."""

    should_run: bool
    reason: str


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

    interval = timedelta(hours=schedule.min_interval_hours)
    if elapsed + DRIFT_GRACE >= interval:
        return RunDecision(True, f"{_format(elapsed)} since last run")

    return RunDecision(
        False,
        f"only {_format(elapsed)} since last run, minimum is "
        f"{schedule.min_interval_hours}h",
    )


def _format(delta: timedelta) -> str:
    hours, remainder = divmod(int(delta.total_seconds()), 3600)
    return f"{hours}h{remainder // 60:02d}m"
