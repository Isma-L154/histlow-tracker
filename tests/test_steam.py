"""Tests for the Steam adapter.

Payload shapes below are copied from live responses captured against the real
endpoints, including the awkward ones: a private profile answering HTTP 200
with an empty object, and free-to-play apps returning `"data": []` as a JSON
array rather than an object.
"""

from __future__ import annotations

from typing import Any

import pytest

from histlow.domain import Money
from histlow.steam import (
    APPDETAILS_URL,
    PRICE_BATCH_SIZE,
    SteamClient,
    WishlistUnavailableError,
)


class FakeHttp:
    """Replays scripted JSON documents and records the requests made."""

    def __init__(self, *documents: Any) -> None:
        self._documents = list(documents)
        self.calls: list[tuple[str, dict]] = []

    def get_json(self, url: str, *, params: dict | None = None, **_: Any) -> Any:
        self.calls.append((url, params or {}))
        return self._documents.pop(0)


def make_client(*documents: Any) -> tuple[SteamClient, FakeHttp]:
    http = FakeHttp(*documents)
    return SteamClient(http, country="ES"), http  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------


class TestFetchWishlist:
    def test_parses_a_populated_wishlist(self) -> None:
        client, http = make_client(
            {
                "response": {
                    "items": [
                        {"appid": 1030300, "priority": 1, "date_added": 1700000000},
                        {"appid": 292030, "priority": 0, "date_added": 1600000000},
                    ]
                }
            }
        )

        entries = client.fetch_wishlist("76561198028121353")

        assert [e.app_id for e in entries] == [1030300, 292030]
        assert entries[0].priority == 1
        assert entries[0].added_at is not None
        assert entries[0].added_at.tzinfo is not None  # always timezone-aware
        assert http.calls[0][1] == {"steamid": "76561198028121353"}

    def test_private_profile_raises_instead_of_reporting_zero_games(self) -> None:
        # Steam answers a private profile with HTTP 200 and `{"response":{}}`.
        # Silently treating that as an empty wishlist would make the tracker
        # permanently quiet with no visible failure.
        client, _ = make_client({"response": {}})

        with pytest.raises(WishlistUnavailableError, match="Public"):
            client.fetch_wishlist("76561198028121353")

    def test_empty_item_list_is_valid_and_not_an_error(self) -> None:
        client, _ = make_client({"response": {"items": []}})
        assert client.fetch_wishlist("76561198028121353") == []

    def test_malformed_entries_are_skipped_without_aborting(self) -> None:
        client, _ = make_client(
            {
                "response": {
                    "items": [
                        {"appid": 730},
                        {"appid": "not-a-number"},
                        {"no_appid": 1},
                        "not-an-object",
                        {"appid": 570},
                    ]
                }
            }
        )

        assert [e.app_id for e in client.fetch_wishlist("1")] == [730, 570]

    def test_missing_date_added_is_tolerated(self) -> None:
        client, _ = make_client({"response": {"items": [{"appid": 730}]}})
        entry = client.fetch_wishlist("1")[0]
        assert entry.added_at is None
        assert entry.priority == 0


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------


class TestFetchPriceQuotes:
    def test_parses_a_discounted_price(self) -> None:
        client, _ = make_client(
            {
                "1030300": {
                    "success": True,
                    "data": {
                        "price_overview": {
                            "currency": "EUR",
                            "initial": 1999,
                            "final": 999,
                            "discount_percent": 50,
                        }
                    },
                }
            }
        )

        quote = client.fetch_price_quotes([1030300])[1030300]

        assert quote.current == Money(999, "EUR")
        assert quote.regular == Money(1999, "EUR")
        assert quote.discount_percent == 50
        assert quote.is_discounted

    def test_sends_the_configured_region(self) -> None:
        client, http = make_client({})
        client.fetch_price_quotes([730])

        url, params = http.calls[0]
        assert url == APPDETAILS_URL
        assert params["cc"] == "ES"
        # The batch projection is what makes multi-id requests legal at all.
        assert params["filters"] == "price_overview"
        assert params["appids"] == "730"

    def test_free_to_play_apps_are_skipped(self) -> None:
        # Live shape: free titles return an empty JSON *array* for `data`.
        client, _ = make_client({"730": {"success": True, "data": []}})
        assert client.fetch_price_quotes([730]) == {}

    def test_unsuccessful_entries_are_skipped(self) -> None:
        client, _ = make_client({"999999": {"success": False}})
        assert client.fetch_price_quotes([999999]) == {}

    def test_entry_without_price_overview_is_skipped(self) -> None:
        client, _ = make_client({"730": {"success": True, "data": {"type": "game"}}})
        assert client.fetch_price_quotes([730]) == {}

    def test_incomplete_price_overview_is_skipped(self) -> None:
        client, _ = make_client(
            {"730": {"success": True, "data": {"price_overview": {"currency": "EUR"}}}}
        )
        assert client.fetch_price_quotes([730]) == {}

    def test_invalid_price_does_not_abort_the_rest_of_the_batch(self) -> None:
        client, _ = make_client(
            {
                "1": {
                    "success": True,
                    "data": {
                        "price_overview": {
                            "currency": "EUR",
                            "initial": 1999,
                            "final": -5,  # rejected by the Money invariant
                            "discount_percent": 50,
                        }
                    },
                },
                "2": {
                    "success": True,
                    "data": {
                        "price_overview": {
                            "currency": "EUR",
                            "initial": 1999,
                            "final": 999,
                            "discount_percent": 50,
                        }
                    },
                },
            }
        )

        quotes = client.fetch_price_quotes([1, 2])
        assert set(quotes) == {2}

    def test_currency_is_normalised_to_upper_case(self) -> None:
        client, _ = make_client(
            {
                "1": {
                    "success": True,
                    "data": {
                        "price_overview": {
                            "currency": "eur",
                            "initial": 1999,
                            "final": 999,
                            "discount_percent": 50,
                        }
                    },
                }
            }
        )
        assert client.fetch_price_quotes([1])[1].current.currency == "EUR"

    def test_requests_are_split_into_batches(self) -> None:
        remainder = 4
        app_ids = list(range(PRICE_BATCH_SIZE * 2 + remainder))
        client, http = make_client({}, {}, {})

        client.fetch_price_quotes(app_ids)

        assert len(http.calls) == 3
        assert len(http.calls[0][1]["appids"].split(",")) == PRICE_BATCH_SIZE
        assert len(http.calls[1][1]["appids"].split(",")) == PRICE_BATCH_SIZE
        assert len(http.calls[2][1]["appids"].split(",")) == remainder

    def test_no_request_is_made_for_an_empty_wishlist(self) -> None:
        client, http = make_client()
        assert client.fetch_price_quotes([]) == {}
        assert http.calls == []

    def test_unexpected_payload_shape_yields_no_quotes(self) -> None:
        client, _ = make_client(["unexpected", "list"])
        assert client.fetch_price_quotes([730]) == {}
