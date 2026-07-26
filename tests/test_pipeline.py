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
from histlow.domain import GameIdentity, HistoricalLow, Money, PriceQuote, WishlistEntry
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
        "schedule": ScheduleConfig(daily_run_hours_utc=(18,)),
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


class FakeItad:
    def __init__(self, titles: dict[int, str], lows: dict[int, int]) -> None:
        self._titles = titles
        self._lows = lows
        self.lookups: list[int] = []
        self.low_requests: list[list[int]] = []

    def lookup(self, app_id: int) -> GameIdentity | None:
        self.lookups.append(app_id)
        if app_id not in self._titles:
            return None
        return GameIdentity(app_id, f"uuid-{app_id}", self._titles[app_id])

    def fetch_steam_lows(self, identities) -> dict[int, HistoricalLow]:
        self.low_requests.append([i.app_id for i in identities])
        return {
            i.app_id: HistoricalLow(i.app_id, Money(self._lows[i.app_id], "EUR"), None)
            for i in identities
            if i.app_id in self._lows
        }


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

    def test_the_same_deal_is_not_republished_on_the_next_run(
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
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
        assert second.published[0]["count"] == 0

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
    def test_a_firing_outside_the_slot_does_no_work(
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
