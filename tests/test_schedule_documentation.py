"""Guards the places that state the tracker's schedule against drifting apart.

The crons in `tracker.yml` are the only executable statement of when the
tracker runs. Three prose sites repeat what they mean: the comment directly
above them, `config.json`, and `docs/SETUP.md`. Nothing read the YAML, so all
four were free to disagree - and did. `config.json` claimed a three-hourly cron
for weeks after the tracker had gone once-daily, two lines above a comment
giving the correct daily time.

`min_interval_hours` is the other half. It gates every firing, so a value set
without reference to how far apart the crons actually fire silently drops runs:
at 20, adding a second daily cron would have been completely inert. The margin
test below pins that arithmetic to the measured delay spread.

Everything here is derived from the cron expressions rather than hard-coded, so
moving the schedule and forgetting the rest fails in CI instead of quietly
misleading whoever reads it next. That includes the *number* of firings: the
prose has to name the cadence, because dropping a cron leaves every remaining
time correctly documented and would otherwise pass unnoticed.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

from histlow.config import ScheduleConfig
from histlow.scheduling import DRIFT_GRACE, decide

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "tracker.yml"
CONFIG = REPO_ROOT / "config.json"
SETUP = REPO_ROOT / "docs" / "SETUP.md"

#: Costa Rica sits at UTC-6 year round and does not observe daylight saving,
#: so the local time never drifts and a fixed offset is exact.
COSTA_RICA_OFFSET_HOURS = -6

#: How late GitHub actually delivered this repository's scheduled runs, measured
#: over the 25 runs to 2026-09-07. The spread, not the average, is what the
#: interval gate has to survive: two firings arrive closer together than their
#: crons by however much the delay shrank between them.
OBSERVED_DELAY_MIN = timedelta(hours=1, minutes=35)
OBSERVED_DELAY_MAX = timedelta(hours=11, minutes=7)

#: How each site must state the cadence. Without this the *number* of crons is
#: unguarded: dropping one back to a single daily firing leaves every remaining
#: time still correctly documented, so nothing else here would notice.
#:
#: Anchored on "fires" rather than the bare phrase because all three files also
#: discuss the old cadence in prose - "Once a day was not enough" - and a bare
#: substring test is satisfied by that sentence no matter what the crons say.
CADENCE_PHRASES = {
    1: "fires once a day",
    2: "fires twice a day",
    3: "fires three times a day",
}

#: Matches a daily cron - "minute hour * * *" - and nothing else. A schedule
#: that stops being daily should fail loudly here rather than be parsed into a
#: time that means nothing.
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
    """The nominal wait between consecutive firings, wrapping past midnight."""
    times = _scheduled_utc()
    minutes = [t.hour * 60 + t.minute for t in times]
    return [
        # -1 then +1 so a lone cron wraps to a full day rather than to zero.
        timedelta(minutes=((nxt - cur - 1) % (24 * 60)) + 1)
        for cur, nxt in zip(minutes, [*minutes[1:], minutes[0] + 24 * 60], strict=True)
    ]


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

    def test_config_json_states_every_time(self) -> None:
        document = _read(CONFIG)
        for stamp in _stamps():
            assert stamp in document, f"config.json does not mention {stamp}"

    def test_the_setup_doc_states_every_time(self) -> None:
        document = _read(SETUP)
        for stamp in _stamps():
            assert stamp in document, f"docs/SETUP.md does not mention {stamp}"

    def test_every_prose_site_names_the_cadence(self) -> None:
        firings = len(_scheduled_utc())
        assert firings in CADENCE_PHRASES, f"no prose wording defined for {firings} firings a day"
        phrase = CADENCE_PHRASES[firings]
        for path in (WORKFLOW, CONFIG, SETUP):
            assert phrase in _read(path).lower(), (
                f"{path.name} does not say {phrase!r}, but tracker.yml has "
                f"{firings} cron entries"
            )


class TestTheIntervalGateCannotDropAScheduledFiring:
    """`min_interval_hours` has to admit two firings that GitHub bunched up.

    A firing delayed a lot followed by one delayed a little arrives closer
    together than the crons ask for. If the gate is wider than that, the second
    run is skipped and the cadence quietly reverts.
    """

    def test_the_crons_are_evenly_spaced(self) -> None:
        # The margin below reasons from a single nominal spacing, which only
        # holds while the firings are evenly distributed around the day.
        assert len(set(_gaps())) == 1, f"firings are not evenly spaced: {_gaps()}"

    def test_the_gate_opens_before_the_tightest_plausible_gap(self) -> None:
        tightest = min(_gaps()) - (OBSERVED_DELAY_MAX - OBSERVED_DELAY_MIN)
        opens_at = timedelta(hours=ScheduleConfig().min_interval_hours) - DRIFT_GRACE
        assert opens_at < tightest, (
            f"min_interval_hours={ScheduleConfig().min_interval_hours} opens the gate at "
            f"{opens_at}, but two firings can land {tightest} apart and would be skipped"
        )

    def test_the_real_gate_admits_the_tightest_plausible_gap(self) -> None:
        # Exercises decide() itself rather than re-deriving its arithmetic.
        tightest = min(_gaps()) - (OBSERVED_DELAY_MAX - OBSERVED_DELAY_MIN)
        now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
        verdict = decide(
            now=now,
            schedule=ScheduleConfig(),
            last_run_at=now - tightest,
            forced=False,
        )
        assert verdict.should_run, verdict.reason

    def test_the_gate_still_rejects_a_duplicated_firing(self) -> None:
        # What the setting is actually for: GitHub delivering the same cron
        # twice, seconds apart.
        now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
        verdict = decide(
            now=now,
            schedule=ScheduleConfig(),
            last_run_at=now - timedelta(seconds=30),
            forced=False,
        )
        assert not verdict.should_run, verdict.reason
