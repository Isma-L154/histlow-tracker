"""Guards the places that state the tracker's schedule against drifting apart.

The crons in `tracker.yml` say when the tracker runs, and `config.json` holds
the interval that gates each firing. Three prose sites repeat what the crons
mean: the comment above them, `docs/SETUP.md` and `README.md`.

Everything here is derived from the crons and the shipped config rather than
hard-coded, because both halves have drifted before. `config.json` claimed a
three-hourly cron for weeks after the tracker had gone once-daily, and setting
its `min_interval_hours` back to 20 - the exact regression that makes a second
cron inert - once passed the whole suite, because the margin tests asserted the
dataclass default instead of the file that ships.

The cadence phrase is anchored on the verb: every one of these files also
discusses the old cadence in prose, so a search for "once a day" would succeed
no matter what the crons said.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

from histlow.config import ScheduleConfig
from histlow.scheduling import DRIFT_GRACE, decide

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "tracker.yml"
CONFIG = REPO_ROOT / "config.json"
SETUP = REPO_ROOT / "docs" / "SETUP.md"
README = REPO_ROOT / "README.md"

#: Costa Rica sits at UTC-6 year round and does not observe daylight saving.
COSTA_RICA_OFFSET_HOURS = -6

#: How late GitHub delivered this repository's scheduled runs, over the 25 runs
#: to 2026-09-07. The spread, not the average, is what the gate has to survive:
#: two firings arrive closer together than their crons by however much the delay
#: shrank between them.
#:
#: Every sample fired from the 12:23 cron, the only one that existed when they
#: were taken, so treat it as a lower bound on the true spread.
OBSERVED_DELAY_MIN = timedelta(hours=1, minutes=35)
OBSERVED_DELAY_MAX = timedelta(hours=11, minutes=7)

#: How each site must state the cadence. README carries no clock times, so it is
#: checked here and not in the timestamp tests.
CADENCE_PHRASES = {
    1: "fires once a day",
    2: "fires twice a day",
    3: "fires three times a day",
}

#: Matches a daily cron - "minute hour * * *" - and nothing else, so a schedule
#: that stops being daily fails loudly rather than parsing into a wrong time.
CRON = re.compile(r'^\s*-\s*cron:\s*"(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*"\s*$', re.MULTILINE)


def _read(path: Path) -> str:
    # utf-8-sig: tracker.yml carries a BOM.
    return path.read_text(encoding="utf-8-sig")


def _scheduled_utc() -> list[time]:
    matches = CRON.findall(_read(WORKFLOW))
    assert matches, "no daily cron found in tracker.yml"
    return sorted(time(int(hour), int(minute)) for minute, hour in matches)


def _as_costa_rica(utc: time) -> time:
    return time((utc.hour + COSTA_RICA_OFFSET_HOURS) % 24, utc.minute)


def _stamps() -> list[str]:
    """Every clock face the documentation is expected to mention."""
    return [t.strftime("%H:%M") for utc in _scheduled_utc() for t in (utc, _as_costa_rica(utc))]


def _gaps() -> list[timedelta]:
    """The nominal wait between firings, wrapping past midnight.

    A single cron is special-cased rather than folded into the modulus, which
    would map a *duplicated* cron line to a full day apart and manufacture a
    margin that does not exist.
    """
    minutes = [t.hour * 60 + t.minute for t in _scheduled_utc()]
    if len(minutes) == 1:
        return [timedelta(days=1)]
    return [
        timedelta(minutes=(nxt - cur) % (24 * 60))
        for cur, nxt in zip(minutes, [*minutes[1:], minutes[0]], strict=True)
    ]


def _shipped_interval() -> int:
    """The interval `load_settings` will actually read at runtime."""
    schedule = json.loads(_read(CONFIG)).get("schedule", {})
    return int(schedule.get("min_interval_hours", ScheduleConfig().min_interval_hours))


def _shipped_schedule() -> ScheduleConfig:
    return ScheduleConfig(min_interval_hours=_shipped_interval())


def _cadence_section() -> str:
    """Just the Cadence section of SETUP.md.

    Scoped, because the document also lists the phone's suggested poll times,
    which could satisfy a timestamp assertion by coincidence.
    """
    body = _read(SETUP).split("### Cadence", 1)[1]
    return body.split("###", 1)[0]


class TestTheCronIsReadable:
    def test_every_cron_entry_is_daily(self) -> None:
        assert _scheduled_utc()

    def test_costa_rica_is_six_hours_behind(self) -> None:
        assert _as_costa_rica(time(12, 23)) == time(6, 23)

    def test_the_offset_wraps_backwards_over_midnight(self) -> None:
        assert _as_costa_rica(time(0, 23)) == time(18, 23)


class TestEveryProseSiteAgreesWithTheCron:
    def test_the_workflow_comment_states_every_time(self) -> None:
        comment = _read(WORKFLOW).split("on:")[0]
        for stamp in _stamps():
            assert stamp in comment, f"tracker.yml comment does not mention {stamp}"

    def test_the_setup_cadence_section_states_every_time(self) -> None:
        section = _cadence_section()
        for stamp in _stamps():
            assert stamp in section, f"the Cadence section of SETUP.md does not mention {stamp}"

    def test_every_prose_site_names_the_cadence(self) -> None:
        firings = len(_scheduled_utc())
        assert firings in CADENCE_PHRASES, f"no prose wording defined for {firings} firings a day"
        phrase = CADENCE_PHRASES[firings]
        for path in (WORKFLOW, SETUP, README):
            assert phrase in _read(path).lower(), (
                f"{path.name} does not say {phrase!r}, but tracker.yml has "
                f"{firings} cron entries"
            )


class TestTheIntervalGateCannotDropAScheduledFiring:
    """`min_interval_hours` has to admit two firings that GitHub bunched up.

    A firing delayed a lot followed by one delayed a little arrives closer
    together than the crons ask for. If the gate is wider than that, the second
    run is skipped, the pipeline logs it at info level, and the cadence quietly
    reverts with nothing failing.

    Every test here reads the interval out of `config.json`, not off the
    dataclass default: the default is a fallback, the file is what ships.
    """

    def test_the_shipped_interval_matches_the_dataclass_default(self) -> None:
        # A divergence means one of the two is stale, and the docs describe one.
        assert _shipped_interval() == ScheduleConfig().min_interval_hours

    def test_the_crons_are_evenly_spaced(self) -> None:
        # A design constraint in its own right: firings bunched into part of the
        # day leave the rest uncovered.
        assert len(set(_gaps())) == 1, f"firings are not evenly spaced: {_gaps()}"

    def test_the_gate_opens_before_the_tightest_plausible_gap(self) -> None:
        tightest = min(_gaps()) - (OBSERVED_DELAY_MAX - OBSERVED_DELAY_MIN)
        opens_at = timedelta(hours=_shipped_interval()) - DRIFT_GRACE
        assert opens_at < tightest, (
            f"config.json ships min_interval_hours={_shipped_interval()}, which opens the "
            f"gate at {opens_at}, but two firings can land {tightest} apart and be skipped"
        )

    def test_the_real_gate_admits_the_tightest_plausible_gap(self) -> None:
        # Exercises decide() itself rather than re-deriving its arithmetic.
        tightest = min(_gaps()) - (OBSERVED_DELAY_MAX - OBSERVED_DELAY_MIN)
        now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
        verdict = decide(
            now=now, schedule=_shipped_schedule(), last_run_at=now - tightest, forced=False
        )
        assert verdict.should_run, verdict.reason

    def test_the_gate_still_rejects_a_duplicated_delivery(self) -> None:
        # What the setting is for: the same cron delivered twice, seconds apart.
        now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
        verdict = decide(
            now=now,
            schedule=_shipped_schedule(),
            last_run_at=now - timedelta(seconds=30),
            forced=False,
        )
        assert not verdict.should_run, verdict.reason

    def test_a_manual_dispatch_is_never_gated(self) -> None:
        # The prose once claimed the interval guards against a manual dispatch
        # landing beside a scheduled run. It does not: force short-circuits.
        now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
        verdict = decide(
            now=now,
            schedule=_shipped_schedule(),
            last_run_at=now - timedelta(seconds=1),
            forced=True,
        )
        assert verdict.should_run, verdict.reason
