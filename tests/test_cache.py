"""Tests for the identity cache and atomic storage helpers."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from histlow.cache import CACHE_VERSION, NEGATIVE_TTL, IdentityCache
from histlow.domain import GameIdentity
from histlow.storage import read_json, write_json_atomic

NOW = datetime(2026, 7, 25, 12, 0, tzinfo=UTC)
SILKSONG = GameIdentity(app_id=1030300, itad_id="uuid-silksong", title="Silksong")


class TestStorage:
    def test_round_trip(self, tmp_path: Path) -> None:
        path = tmp_path / "data.json"
        write_json_atomic(path, {"a": 1})
        assert read_json(path, default=None) == {"a": 1}

    def test_missing_file_returns_the_default(self, tmp_path: Path) -> None:
        assert read_json(tmp_path / "absent.json", default={"fallback": True}) == {"fallback": True}

    def test_corrupt_file_degrades_instead_of_raising(self, tmp_path: Path) -> None:
        # Losing cached state costs one noisier run; aborting would leave the
        # tracker broken until someone intervened by hand.
        path = tmp_path / "data.json"
        path.write_text("{ truncated", encoding="utf-8")
        assert read_json(path, default={}) == {}

    def test_creates_missing_parent_directories(self, tmp_path: Path) -> None:
        path = tmp_path / "nested" / "deeper" / "data.json"
        write_json_atomic(path, [1, 2, 3])
        assert json.loads(path.read_text(encoding="utf-8")) == [1, 2, 3]

    def test_leaves_no_temporary_files_behind(self, tmp_path: Path) -> None:
        write_json_atomic(tmp_path / "data.json", {"a": 1})
        assert [p.name for p in tmp_path.iterdir()] == ["data.json"]

    def test_overwrites_an_existing_file(self, tmp_path: Path) -> None:
        path = tmp_path / "data.json"
        write_json_atomic(path, {"generation": 1})
        write_json_atomic(path, {"generation": 2})
        assert read_json(path, default=None) == {"generation": 2}


class TestIdentityCache:
    def test_missing_file_starts_empty(self, tmp_path: Path) -> None:
        assert len(IdentityCache.load(tmp_path / "identities.json")) == 0

    def test_remembers_across_a_save_and_reload(self, tmp_path: Path) -> None:
        path = tmp_path / "identities.json"
        cache = IdentityCache.load(path)
        cache.remember(SILKSONG, now=NOW)
        cache.save()

        assert IdentityCache.load(path).get(1030300, now=NOW) == SILKSONG

    def test_unknown_app_returns_none(self, tmp_path: Path) -> None:
        assert IdentityCache.load(tmp_path / "c.json").get(730, now=NOW) is None

    def test_save_is_skipped_when_nothing_changed(self, tmp_path: Path) -> None:
        path = tmp_path / "identities.json"
        IdentityCache.load(path).save()
        assert not path.exists()

    def test_a_version_bump_discards_the_old_file(self, tmp_path: Path) -> None:
        path = tmp_path / "identities.json"
        path.write_text(
            json.dumps({"version": CACHE_VERSION + 1, "entries": {"730": {}}}), encoding="utf-8"
        )
        assert len(IdentityCache.load(path)) == 0

    def test_malformed_entries_are_dropped_on_load(self, tmp_path: Path) -> None:
        path = tmp_path / "identities.json"
        path.write_text(
            json.dumps(
                {
                    "version": CACHE_VERSION,
                    "entries": {
                        "730": {"itad_id": "uuid-a", "title": "Ok", "resolved_at": NOW.isoformat()},
                        "not-an-int": {"itad_id": "b", "resolved_at": NOW.isoformat()},
                        "570": {"itad_id": "c"},  # no resolved_at
                        "440": "not-an-object",
                    },
                }
            ),
            encoding="utf-8",
        )

        cache = IdentityCache.load(path)
        assert len(cache) == 1
        assert cache.get(730, now=NOW) is not None


class TestNegativeCaching:
    def test_a_fresh_miss_suppresses_further_lookups(self, tmp_path: Path) -> None:
        cache = IdentityCache.load(tmp_path / "c.json")
        cache.remember_missing(999999, now=NOW)

        assert cache.get(999999, now=NOW) is None
        assert cache.knows(999999, now=NOW) is True  # no lookup needed

    def test_an_expired_miss_is_retried(self, tmp_path: Path) -> None:
        # A game absent today may be catalogued later; a permanent negative
        # entry would hide it forever.
        cache = IdentityCache.load(tmp_path / "c.json")
        cache.remember_missing(999999, now=NOW)

        later = NOW + NEGATIVE_TTL + timedelta(seconds=1)
        assert cache.knows(999999, now=later) is False

    def test_a_positive_entry_never_expires(self, tmp_path: Path) -> None:
        cache = IdentityCache.load(tmp_path / "c.json")
        cache.remember(SILKSONG, now=NOW)

        far_future = NOW + timedelta(days=3650)
        assert cache.knows(1030300, now=far_future) is True
        assert cache.get(1030300, now=far_future) == SILKSONG

    def test_expired_misses_survive_a_reload_until_queried(self, tmp_path: Path) -> None:
        path = tmp_path / "c.json"
        cache = IdentityCache.load(path)
        cache.remember_missing(999999, now=NOW)
        cache.save()

        later = NOW + NEGATIVE_TTL + timedelta(days=1)
        reloaded = IdentityCache.load(path)
        assert reloaded.knows(999999, now=later) is False
