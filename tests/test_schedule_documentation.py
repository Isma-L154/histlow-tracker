"""Guards the places that state the tracker's schedule against drifting apart.

The cron in `tracker.yml` is the only executable statement of when the tracker
runs. Three prose sites repeat what it means: the comment directly above it,
`config.json`, and `docs/SETUP.md`. Nothing read the YAML, so all four were
free to disagree - and did. `config.json` claimed a three-hourly cron for weeks
after the tracker had gone once-daily, two lines above a comment giving the
correct daily time.

These tests derive the times from the cron itself rather than hard-coding them,
so moving the schedule and forgetting the prose fails here instead of quietly
misleading whoever reads it next.
"""

from __future__ import annotations

import re
from datetime import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "tracker.yml"
CONFIG = REPO_ROOT / "config.json"
SETUP = REPO_ROOT / "docs" / "SETUP.md"

#: Costa Rica sits at UTC-6 year round and does not observe daylight saving,
#: so the local time never drifts and a fixed offset is exact.
COSTA_RICA_OFFSET_HOURS = -6

#: Matches a daily cron - "minute hour * * *" - and nothing else. A schedule
#: that stops being once-daily should fail loudly here rather than be parsed
#: into a time that means nothing.
CRON = re.compile(r'^\s*-\s*cron:\s*"(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*"\s*$', re.MULTILINE)


def _read(path: Path) -> str:
    # utf-8-sig: tracker.yml carries a BOM.
    return path.read_text(encoding="utf-8-sig")


def _scheduled_utc() -> time:
    matches = CRON.findall(_read(WORKFLOW))
    assert len(matches) == 1, f"expected exactly one daily cron in tracker.yml, found {matches}"
    minute, hour = (int(value) for value in matches[0])
    return time(hour, minute)


def _as_costa_rica(utc: time) -> time:
    return time((utc.hour + COSTA_RICA_OFFSET_HOURS) % 24, utc.minute)


def _stamps() -> tuple[str, str]:
    utc = _scheduled_utc()
    return utc.strftime("%H:%M"), _as_costa_rica(utc).strftime("%H:%M")


class TestTheCronIsReadable:
    def test_the_workflow_defines_exactly_one_daily_cron(self) -> None:
        assert _scheduled_utc() is not None

    def test_costa_rica_is_six_hours_behind(self) -> None:
        assert _as_costa_rica(time(12, 23)) == time(6, 23)

    def test_the_offset_wraps_backwards_over_midnight(self) -> None:
        # The previous schedule, 00:17 UTC, was 18:17 the day before locally.
        assert _as_costa_rica(time(0, 17)) == time(18, 17)


class TestEveryProseSiteAgreesWithTheCron:
    def test_the_workflow_comment_states_both_times(self) -> None:
        utc, local = _stamps()
        comment = _read(WORKFLOW).split("on:")[0]
        assert utc in comment, f"tracker.yml comment does not mention {utc} UTC"
        assert local in comment, f"tracker.yml comment does not mention {local} Costa Rica"

    def test_config_json_states_both_times(self) -> None:
        utc, local = _stamps()
        document = _read(CONFIG)
        assert utc in document, f"config.json does not mention {utc} UTC"
        assert local in document, f"config.json does not mention {local} Costa Rica"

    def test_the_setup_doc_states_both_times(self) -> None:
        utc, local = _stamps()
        document = _read(SETUP)
        assert utc in document, f"docs/SETUP.md does not mention {utc} UTC"
        assert local in document, f"docs/SETUP.md does not mention {local} Costa Rica"
