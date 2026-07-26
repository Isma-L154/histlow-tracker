"""Tests for persisted run state and the anti-spam rule."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from histlow.domain import Money
from histlow.state import STATE_VERSION, TrackerState

NOW = datetime(2026, 7, 25, 18, 0, tzinfo=UTC)


@pytest.fixture
def state(tmp_path: Path) -> TrackerState:
    return TrackerState.load(tmp_path / "state.json")


class TestShouldAlert:
    def test_an_unseen_game_alerts(self, state: TrackerState) -> None:
        assert state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_the_same_price_does_not_alert_again(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert not state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_a_worse_price_does_not_alert(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert not state.should_alert(1, Money(1299, "EUR"), threshold_minor=1)

    def test_a_better_price_alerts(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert state.should_alert(1, Money(998, "EUR"), threshold_minor=1)

    def test_the_threshold_is_inclusive(self, state: TrackerState) -> None:
        state.record_alert(1, Money(1000, "EUR"), now=NOW)
        assert state.should_alert(1, Money(900, "EUR"), threshold_minor=100)
        assert not state.should_alert(1, Money(901, "EUR"), threshold_minor=100)

    def test_a_currency_change_is_treated_as_unseen(self, state: TrackerState) -> None:
        # The region was reconfigured, so the stored price is not comparable.
        # Suppressing on it would hide a genuine deal.
        state.record_alert(1, Money(999, "USD"), now=NOW)
        assert state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_records_are_independent_per_game(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        assert state.should_alert(2, Money(9999, "EUR"), threshold_minor=1)


class TestPersistence:
    def test_round_trips_alerts_and_last_run(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        state = TrackerState.load(path)
        state.record_alert(1030300, Money(999, "EUR"), now=NOW)
        state.mark_run(NOW)
        state.save()

        reloaded = TrackerState.load(path)
        assert reloaded.last_run_at == NOW
        assert not reloaded.should_alert(1030300, Money(999, "EUR"), threshold_minor=1)

    def test_a_fresh_state_has_no_last_run(self, state: TrackerState) -> None:
        assert state.last_run_at is None

    def test_save_is_skipped_when_nothing_changed(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        TrackerState.load(path).save()
        assert not path.exists()

    def test_a_version_bump_discards_the_file(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        path.write_text(
            json.dumps({"version": STATE_VERSION + 1, "alerts": {"1": {}}}), encoding="utf-8"
        )
        assert len(TrackerState.load(path)) == 0

    def test_a_corrupt_file_degrades_to_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        path.write_text("{ truncated", encoding="utf-8")
        assert len(TrackerState.load(path)) == 0

    def test_malformed_records_are_dropped_individually(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        path.write_text(
            json.dumps(
                {
                    "version": STATE_VERSION,
                    "last_run_at": NOW.isoformat(),
                    "alerts": {
                        "1": {
                            "price_minor": 999,
                            "currency": "EUR",
                            "alerted_at": NOW.isoformat(),
                        },
                        "2": {"price_minor": "nine", "currency": "EUR",
                              "alerted_at": NOW.isoformat()},
                        "3": {"price_minor": 999, "currency": "EUR"},
                        "4": "not-an-object",
                    },
                }
            ),
            encoding="utf-8",
        )

        state = TrackerState.load(path)
        assert len(state) == 1
        assert not state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_a_naive_timestamp_is_assumed_utc(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        path.write_text(
            json.dumps({"version": STATE_VERSION, "last_run_at": "2026-07-25T18:00:00"}),
            encoding="utf-8",
        )
        assert TrackerState.load(path).last_run_at == NOW


class TestPurge:
    def test_expired_records_are_dropped(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        later = NOW + timedelta(days=200)

        assert state.purge_expired(retention=timedelta(days=180), now=later) == 1
        assert state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_fresh_records_survive(self, state: TrackerState) -> None:
        state.record_alert(1, Money(999, "EUR"), now=NOW)
        later = NOW + timedelta(days=10)

        assert state.purge_expired(retention=timedelta(days=180), now=later) == 0
        assert not state.should_alert(1, Money(999, "EUR"), threshold_minor=1)

    def test_purging_nothing_is_safe(self, state: TrackerState) -> None:
        assert state.purge_expired(retention=timedelta(days=180), now=NOW) == 0
