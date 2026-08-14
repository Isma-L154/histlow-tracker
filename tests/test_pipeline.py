"""End-to-end tests for the orchestration, driven entirely by fakes.

These assert the control flow itself: that the discount filter runs before any
historical data is requested, that the identity cache suppresses repeat
lookups, and that state is only advanced after a successful publish.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from histlow.config import (
    AlertRules,
    NotificationConfig,
    ScheduleConfig,
    Secrets,
    Settings,
    StateConfig,
)
from histlow.domain import (
    GameIdentity,
    HistoricalLow,
    Money,
    PricePoint,
    PriceQuote,
    WishlistEntry,
)
from histlow.pipeline import Paths, run
from histlow.publisher import PublishError

NOW = datetime(2026, 7, 25, 18, 5, tzinfo=UTC)


def make_settings(**overrides) -> Settings:
    base = {
        "secrets": Secrets("76561199094002095", "itad-key", "gist-id", "gist-token"),
        "country": "ES",
        # Same as `country` by default, so most tests run one region and the
        # reference fetch is skipped entirely.
        "comparison_country": "ES",
        "dry_run": False,
        "schedule": ScheduleConfig(min_interval_hours=3),
        "alerts": AlertRules(),
        "notification": NotificationConfig(headline_template="{count} deals"),
        "state": StateConfig(),
    }
    return Settings(**{**base, **overrides})


class FakeSteam:
    def __init__(self, wishlist: list[int], quotes: dict[int, PriceQuote]) -> None:
        self._wishlist = wishlist
        self._quotes = quotes
        self.price_requests: list[list[int]] = []

    def fetch_wishlist(self, _steam_id: str) -> list[WishlistEntry]:
        return [WishlistEntry(app_id=app_id) for app_id in self._wishlist]

    def fetch_price_quotes(self, app_ids) -> dict[int, PriceQuote]:
        self.price_requests.append(list(app_ids))
        return {app_id: self._quotes[app_id] for app_id in app_ids if app_id in self._quotes}


RECORD_SET_AT = datetime(2026, 7, 14, 19, 16, 38, tzinfo=UTC)
LATER_SALE_AT = datetime(2026, 7, 20, 19, 27, 57, tzinfo=UTC)
EARLIER_AT = datetime(2026, 3, 1, tzinfo=UTC)


class FakeItad:
    """Serves identities, lows and a price history consistent with them.

    By default every game's current sale set its record. `matching` names the
    ones that instead returned to a record from an earlier sale, mirroring the
    Dispatch case: the low is stamped months before the newest history entry.
    """

    def __init__(
        self,
        titles: dict[int, str],
        lows: dict[int, int],
        matching: frozenset[int] = frozenset(),
    ) -> None:
        self._titles = titles
        self._lows = lows
        self._matching = matching
        self.lookups: list[int] = []
        self.low_requests: list[list[int]] = []
        self.history_requests: list[str] = []

    def lookup(self, app_id: int) -> GameIdentity | None:
        self.lookups.append(app_id)
        if app_id not in self._titles:
            return None
        return GameIdentity(app_id, f"uuid-{app_id}", self._titles[app_id])

    def fetch_steam_lows(self, identities) -> dict[int, HistoricalLow]:
        self.low_requests.append([i.app_id for i in identities])
        return {
            i.app_id: HistoricalLow(
                i.app_id,
                Money(self._lows[i.app_id], "EUR"),
                EARLIER_AT if i.app_id in self._matching else RECORD_SET_AT,
            )
            for i in identities
            if i.app_id in self._lows
        }

    def fetch_price_history(self, itad_id: str) -> list[PricePoint]:
        self.history_requests.append(itad_id)
        app_id = int(itad_id.removeprefix("uuid-"))
        low = self._lows.get(app_id, 0)

        if app_id in self._matching:
            # Newest entry is later than the recorded low: matching, not new.
            return [
                PricePoint(Money(low, "EUR"), LATER_SALE_AT),
                PricePoint(Money(low, "EUR"), EARLIER_AT),
            ]
        # Newest entry carries the low's own timestamp: this sale set it.
        return [
            PricePoint(Money(low, "EUR"), RECORD_SET_AT),
            PricePoint(Money(low + 500, "EUR"), EARLIER_AT),
        ]


class FakePublisher:
    def __init__(self, error: Exception | None = None) -> None:
        self.published: list[dict] = []
        self._error = error

    def publish(self, payload: dict) -> str:
        if self._error:
            raise self._error
        self.published.append(payload)
        return "https://gist.example/raw/histlow.json"


def quote(app_id: int, current: int, regular: int, discount: int) -> PriceQuote:
    return PriceQuote(app_id, Money(current, "EUR"), Money(regular, "EUR"), discount)


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths.under(tmp_path)


def execute(
    paths: Paths,
    steam: FakeSteam,
    itad: FakeItad,
    publisher: FakePublisher,
    *,
    settings: Settings | None = None,
    now: datetime = NOW,
    forced: bool = False,
    monkeypatch: pytest.MonkeyPatch,
):
    """Runs the pipeline with every adapter replaced."""
    import histlow.pipeline as pipeline

    monkeypatch.setattr(pipeline, "SteamClient", lambda *a, **k: steam)
    monkeypatch.setattr(pipeline, "ItadClient", lambda *a, **k: itad)
    monkeypatch.setattr(pipeline, "_build_publisher", lambda *a, **k: publisher)
    monkeypatch.setattr(pipeline, "HttpClient", lambda *a, **k: object())

    return run(settings or make_settings(), paths=paths, now=now, forced=forced)


class TestHappyPath:
    def test_alerts_only_on_games_at_their_all_time_low(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(
            wishlist=[1, 2, 3, 4],
            quotes={
                1: quote(1, 999, 1999, 50),  # at its low -> alert
                2: quote(2, 1500, 2000, 25),  # discounted but above its low
                3: quote(3, 5999, 5999, 0),  # not discounted
                4: quote(4, 500, 2000, 75),  # below its low -> alert
            },
        )
        itad = FakeItad(titles={1: "One", 2: "Two", 4: "Four"}, lows={1: 999, 2: 1000, 4: 600})
        publisher = FakePublisher()

        result = execute(paths, steam, itad, publisher, monkeypatch=monkeypatch)

        assert result.ran
        assert result.wishlist_size == 4
        assert result.discounted == 3
        assert result.qualifying == 2
        assert result.alerted == 2

        payload = publisher.published[0]
        assert payload["count"] == 2
        assert {d["title"] for d in payload["deals"]} == {"One", "Four"}

    def test_historical_data_is_requested_only_for_discounted_games(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The core optimisation: full-price games never reach ITAD.
        steam = FakeSteam(
            wishlist=[1, 2, 3],
            quotes={
                1: quote(1, 999, 1999, 50),
                2: quote(2, 5999, 5999, 0),
                3: quote(3, 3999, 3999, 0),
            },
        )
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)

        assert itad.lookups == [1]
        assert itad.low_requests == [[1]]

    def test_prices_are_requested_for_the_whole_wishlist(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(wishlist=[1, 2, 3], quotes={})
        execute(paths, steam, FakeItad({}, {}), FakePublisher(), monkeypatch=monkeypatch)
        assert steam.price_requests == [[1, 2, 3]]

    def test_an_empty_result_still_publishes(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Keeps generated_at fresh so the Shortcut can tell silence from
        # breakage.
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 5999, 5999, 0)})
        publisher = FakePublisher()

        execute(paths, steam, FakeItad({}, {}), publisher, monkeypatch=monkeypatch)

        assert publisher.published[0]["count"] == 0


class TestDeduplication:
    def _steam(self) -> FakeSteam:
        return FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)})

    def test_the_same_deal_keeps_showing_inside_the_repeat_window(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The phone polls on a timer. A payload that appeared and vanished
        # between two polls was never read, and the deal was recorded as
        # alerted, so it would never have been published again.
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        first = FakePublisher()
        execute(paths, self._steam(), itad, first, monkeypatch=monkeypatch)
        assert first.published[0]["count"] == 1

        second = FakePublisher()
        execute(
            paths,
            self._steam(),
            itad,
            second,
            now=NOW + timedelta(days=1),
            monkeypatch=monkeypatch,
        )
        assert second.published[0]["count"] == 1

    def test_the_same_deal_drops_out_once_the_window_closes(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        itad = FakeItad(titles={1: "One"}, lows={1: 999})
        execute(paths, self._steam(), itad, FakePublisher(), monkeypatch=monkeypatch)

        later = FakePublisher()
        execute(
            paths,
            self._steam(),
            itad,
            later,
            now=NOW + timedelta(days=3),
            monkeypatch=monkeypatch,
        )
        assert later.published[0]["count"] == 0

    def test_a_long_sale_does_not_repeat_forever(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The window is anchored to when the deal was first reported. Were a
        # repeat to re-record it, the anchor would advance every run and a
        # month-long sale would notify every single day.
        itad = FakeItad(titles={1: "One"}, lows={1: 999})
        execute(paths, self._steam(), itad, FakePublisher(), monkeypatch=monkeypatch)

        for day in (1, 2):
            execute(
                paths,
                self._steam(),
                itad,
                FakePublisher(),
                now=NOW + timedelta(days=day),
                monkeypatch=monkeypatch,
            )

        final = FakePublisher()
        execute(
            paths,
            self._steam(),
            itad,
            final,
            now=NOW + timedelta(days=5),
            monkeypatch=monkeypatch,
        )
        assert final.published[0]["count"] == 0

    def test_a_lower_price_alerts_again(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        itad = FakeItad(titles={1: "One"}, lows={1: 999})
        execute(paths, self._steam(), itad, FakePublisher(), monkeypatch=monkeypatch)

        cheaper = FakeSteam(wishlist=[1], quotes={1: quote(1, 899, 1999, 55)})
        publisher = FakePublisher()
        execute(
            paths, cheaper, itad, publisher, now=NOW + timedelta(days=1), monkeypatch=monkeypatch
        )

        assert publisher.published[0]["count"] == 1


class TestIdentityCaching:
    def test_lookups_are_not_repeated_across_runs(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 1500, 1999, 25)})
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)
        assert itad.lookups == [1]

        execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            now=NOW + timedelta(days=1),
            monkeypatch=monkeypatch,
        )
        assert itad.lookups == [1]  # served from the cache

    def test_a_game_unknown_to_itad_is_not_re_queried(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(wishlist=[99], quotes={99: quote(99, 1500, 1999, 25)})
        itad = FakeItad(titles={}, lows={})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)
        execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            now=NOW + timedelta(days=1),
            monkeypatch=monkeypatch,
        )

        assert itad.lookups == [99]


class TestScheduleGate:
    def test_a_firing_inside_the_interval_does_no_work(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)})
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)

        publisher = FakePublisher()
        result = execute(
            paths,
            steam,
            itad,
            publisher,
            now=NOW + timedelta(hours=1),
            monkeypatch=monkeypatch,
        )

        assert not result.ran
        assert publisher.published == []

    def test_force_bypasses_the_gate(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)})
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)
        result = execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            now=NOW + timedelta(hours=1),
            forced=True,
            monkeypatch=monkeypatch,
        )

        assert result.ran


class TestRecordFilter:
    """With require_new_record on, only sales that beat the record are sent."""

    def _steam(self) -> FakeSteam:
        return FakeSteam(
            wishlist=[1, 2],
            quotes={1: quote(1, 999, 1999, 50), 2: quote(2, 899, 1999, 55)},
        )

    def test_a_game_only_matching_its_record_is_not_alerted(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # App 1 returns to an old record, app 2 beats its own.
        itad = FakeItad(
            titles={1: "Matched", 2: "Beat it"},
            lows={1: 999, 2: 899},
            matching=frozenset({1}),
        )
        publisher = FakePublisher()

        result = execute(paths, self._steam(), itad, publisher, monkeypatch=monkeypatch)

        assert result.qualifying == 2  # both are at their all-time low
        assert result.record_setting == 1  # only one beat it
        assert [d["title"] for d in publisher.published[0]["deals"]] == ["Beat it"]

    def test_nothing_is_alerted_when_no_record_is_beaten(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        itad = FakeItad(
            titles={1: "Matched", 2: "Also matched"},
            lows={1: 999, 2: 899},
            matching=frozenset({1, 2}),
        )
        publisher = FakePublisher()

        result = execute(paths, self._steam(), itad, publisher, monkeypatch=monkeypatch)

        assert result.qualifying == 2
        assert result.alerted == 0
        assert publisher.published[0]["count"] == 0

    def test_disabling_the_rule_reports_matches_too(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        itad = FakeItad(
            titles={1: "Matched", 2: "Beat it"},
            lows={1: 999, 2: 899},
            matching=frozenset({1}),
        )
        publisher = FakePublisher()
        settings = make_settings(alerts=AlertRules(require_new_record=False))

        execute(paths, self._steam(), itad, publisher, settings=settings, monkeypatch=monkeypatch)

        assert publisher.published[0]["count"] == 2

    def test_history_is_only_requested_for_games_at_their_low(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # App 2 is discounted but above its low, so it never reaches history.
        steam = FakeSteam(
            wishlist=[1, 2],
            quotes={1: quote(1, 999, 1999, 50), 2: quote(2, 1500, 1999, 25)},
        )
        itad = FakeItad(titles={1: "At low", 2: "Above low"}, lows={1: 999, 2: 500})

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)

        assert itad.history_requests == ["uuid-1"]


class TestDryRun:
    def _fixtures(self) -> tuple[FakeSteam, FakeItad]:
        return (
            FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)}),
            FakeItad(titles={1: "One"}, lows={1: 999}),
        )

    def test_a_dry_run_does_not_suppress_the_next_real_run(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Previewing a deal must not mark it as reported. Otherwise the real
        # run stays silent about exactly what the preview just showed.
        steam, itad = self._fixtures()

        preview = FakePublisher()
        execute(
            paths,
            steam,
            itad,
            preview,
            settings=make_settings(dry_run=True),
            monkeypatch=monkeypatch,
        )
        assert preview.published[0]["count"] == 1

        real = FakePublisher()
        execute(paths, steam, itad, real, monkeypatch=monkeypatch)
        assert real.published[0]["count"] == 1

    def test_a_dry_run_does_not_advance_the_schedule_gate(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam, itad = self._fixtures()
        execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            settings=make_settings(dry_run=True),
            monkeypatch=monkeypatch,
        )

        # No last_run_at was recorded, so an unforced run still proceeds.
        result = execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)
        assert result.ran

    def test_a_dry_run_writes_no_state_file(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        steam, itad = self._fixtures()
        execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            settings=make_settings(dry_run=True),
            monkeypatch=monkeypatch,
        )
        assert not paths.state.exists()

    def test_a_dry_run_still_persists_the_identity_cache(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A pure performance cache: it cannot change which deals qualify.
        steam, itad = self._fixtures()
        execute(
            paths,
            steam,
            itad,
            FakePublisher(),
            settings=make_settings(dry_run=True),
            monkeypatch=monkeypatch,
        )
        assert paths.identities.exists()


class TestReferenceQuotes:
    """Covers the cross-region path used when ITAD does not track the currency."""

    def _store(self) -> dict[int, PriceQuote]:
        return {1: PriceQuote(1, Money(1500000, "CRC"), Money(3750000, "CRC"), 60)}

    def test_same_region_reuses_the_store_prices_without_a_request(self) -> None:
        from histlow.pipeline import _reference_quotes

        steam = FakeSteam(wishlist=[], quotes={})
        store = self._store()

        assert _reference_quotes(make_settings(), steam, store, [1]) is store
        assert steam.price_requests == []

    def test_a_different_region_is_fetched_for_the_discounted_subset_only(self) -> None:
        from histlow.pipeline import _reference_quotes

        reference = {1: PriceQuote(1, Money(2799, "USD"), Money(6999, "USD"), 60)}
        steam = FakeSteam(wishlist=[], quotes=reference)
        settings = make_settings(country="CR", comparison_country="US")

        result = _reference_quotes(settings, steam, self._store(), [1])

        assert result[1].current == Money(2799, "USD")
        assert steam.price_requests == [[1]]

    def test_nothing_discounted_means_no_request(self) -> None:
        from histlow.pipeline import _reference_quotes

        steam = FakeSteam(wishlist=[], quotes={})
        settings = make_settings(country="CR", comparison_country="US")

        assert _reference_quotes(settings, steam, {}, []) == {}
        assert steam.price_requests == []


class TestFailureHandling:
    def test_a_publish_failure_does_not_suppress_the_next_attempt(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # State must not advance on a failed publish, or the deal would be
        # marked as reported without the user ever seeing it.
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)})
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        with pytest.raises(PublishError):
            execute(
                paths,
                steam,
                itad,
                FakePublisher(error=PublishError("boom")),
                monkeypatch=monkeypatch,
            )

        publisher = FakePublisher()
        result = execute(paths, steam, itad, publisher, monkeypatch=monkeypatch)

        assert result.alerted == 1
        assert publisher.published[0]["count"] == 1

    def test_identity_lookups_survive_a_later_failure(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Work already paid for is kept, so the retry is cheaper.
        steam = FakeSteam(wishlist=[1], quotes={1: quote(1, 999, 1999, 50)})
        itad = FakeItad(titles={1: "One"}, lows={1: 999})

        with pytest.raises(PublishError):
            execute(
                paths,
                steam,
                itad,
                FakePublisher(error=PublishError("boom")),
                monkeypatch=monkeypatch,
            )

        execute(paths, steam, itad, FakePublisher(), monkeypatch=monkeypatch)
        assert itad.lookups == [1]
