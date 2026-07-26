"""Tests for the IsThereAnyDeal adapter.

Payload shapes follow the published schema for `games/lookup/v1` and
`games/storelow/v2`, including the `+01:00` offset style ITAD uses for
timestamps.
"""

from __future__ import annotations

from typing import Any

import pytest

from histlow.domain import ITAD_STEAM_SHOP_ID, GameIdentity, Money
from histlow.itad import (
    API_KEY_HEADER,
    STORELOW_BATCH_SIZE,
    ItadAuthError,
    ItadClient,
    ItadError,
)
from histlow.net import PermanentHttpError

API_KEY = "itad-test-key-value"

SILKSONG = GameIdentity(app_id=1030300, itad_id="uuid-silksong", title="Silksong")
CYBERPUNK = GameIdentity(app_id=1091500, itad_id="uuid-cyberpunk", title="Cyberpunk 2077")


class FakeHttp:
    """Replays scripted documents (or raises scripted errors) and records calls."""

    def __init__(self, *outcomes: Any) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[dict[str, Any]] = []

    def _next(self, **call: Any) -> Any:
        self.calls.append(call)
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def get_json(self, url: str, *, params: dict | None = None, headers: dict | None = None) -> Any:
        return self._next(method="GET", url=url, params=params or {}, headers=headers or {})

    def post_json(
        self,
        url: str,
        *,
        payload: Any,
        params: dict | None = None,
        headers: dict | None = None,
    ) -> Any:
        return self._next(
            method="POST", url=url, payload=payload, params=params or {}, headers=headers or {}
        )


def make_client(*outcomes: Any) -> tuple[ItadClient, FakeHttp]:
    http = FakeHttp(*outcomes)
    return ItadClient(http, api_key=API_KEY, country="ES"), http  # type: ignore[arg-type]


def steam_low(amount_int: int, currency: str = "EUR") -> dict:
    return {
        "shop": {"id": ITAD_STEAM_SHOP_ID, "name": "Steam"},
        "price": {"amount": amount_int / 100, "amountInt": amount_int, "currency": currency},
        "regular": {"amount": 19.99, "amountInt": 1999, "currency": currency},
        "cut": 50,
        "timestamp": "2022-11-29T02:14:37+01:00",
    }


def keyshop_low(amount_int: int) -> dict:
    return {
        "shop": {"id": 13, "name": "DLGamer"},
        "price": {"amount": amount_int / 100, "amountInt": amount_int, "currency": "EUR"},
        "regular": {"amount": 21.99, "amountInt": 2199, "currency": "EUR"},
        "cut": 70,
        "timestamp": "2022-11-29T02:14:37+01:00",
    }


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


class TestLookup:
    def test_resolves_id_and_title(self) -> None:
        client, http = make_client(
            {"found": True, "game": {"id": "uuid-silksong", "title": "Hollow Knight: Silksong"}}
        )

        identity = client.lookup(1030300)

        assert identity == GameIdentity(1030300, "uuid-silksong", "Hollow Knight: Silksong")
        assert http.calls[0]["params"] == {"appid": 1030300}

    def test_sends_the_key_as_a_header_never_a_query_parameter(self) -> None:
        # Keeps the credential out of URLs, and therefore out of logs.
        client, http = make_client({"found": False})
        client.lookup(730)

        assert http.calls[0]["headers"] == {API_KEY_HEADER: API_KEY}
        assert "key" not in http.calls[0]["params"]

    def test_unknown_game_returns_none_rather_than_raising(self) -> None:
        client, _ = make_client({"found": False})
        assert client.lookup(999999) is None

    def test_missing_title_falls_back_to_the_app_id(self) -> None:
        client, _ = make_client({"found": True, "game": {"id": "uuid-x"}})
        assert client.lookup(4242).title == "App 4242"

    def test_record_without_an_id_is_rejected(self) -> None:
        client, _ = make_client({"found": True, "game": {"title": "No id"}})
        assert client.lookup(4242) is None

    def test_unexpected_payload_is_treated_as_not_found(self) -> None:
        client, _ = make_client(["unexpected"])
        assert client.lookup(4242) is None

    @pytest.mark.parametrize("status", [401, 403])
    def test_rejected_key_raises_an_actionable_auth_error(self, status: int) -> None:
        error = PermanentHttpError("denied")
        error.status = status
        client, _ = make_client(error)

        with pytest.raises(ItadAuthError, match=r"isthereanydeal\.com/apps/my"):
            client.lookup(730)

    def test_auth_error_message_never_contains_the_key(self) -> None:
        error = PermanentHttpError("denied")
        error.status = 401
        client, _ = make_client(error)

        with pytest.raises(ItadAuthError) as excinfo:
            client.lookup(730)
        assert API_KEY not in str(excinfo.value)

    def test_other_permanent_failures_surface_as_itad_errors(self) -> None:
        error = PermanentHttpError("400 Bad Request")
        error.status = 400
        client, _ = make_client(error)

        with pytest.raises(ItadError):
            client.lookup(730)


# ---------------------------------------------------------------------------
# Store lows
# ---------------------------------------------------------------------------


class TestFetchSteamLows:
    def test_parses_a_steam_low(self) -> None:
        client, _ = make_client([{"id": "uuid-silksong", "lows": [steam_low(999)]}])

        low = client.fetch_steam_lows([SILKSONG])[1030300]

        assert low.low == Money(999, "EUR")
        assert low.recorded_at is not None
        assert low.recorded_at.tzinfo is not None

    def test_scopes_the_request_to_steam_and_the_configured_country(self) -> None:
        client, http = make_client([])
        client.fetch_steam_lows([SILKSONG])

        call = http.calls[0]
        assert call["params"] == {"country": "ES", "shops": str(ITAD_STEAM_SHOP_ID)}
        assert call["payload"] == ["uuid-silksong"]
        assert call["headers"] == {API_KEY_HEADER: API_KEY}

    def test_key_reseller_lows_are_ignored_even_if_returned(self) -> None:
        # The request already filters on shop 61, but trusting that blindly
        # would make the tracker permanently silent should the filter ever be
        # ignored: a reseller low is almost always below any Steam price.
        client, _ = make_client([{"id": "uuid-silksong", "lows": [keyshop_low(499)]}])
        assert client.fetch_steam_lows([SILKSONG]) == {}

    def test_picks_the_steam_entry_out_of_a_mixed_list(self) -> None:
        client, _ = make_client(
            [{"id": "uuid-silksong", "lows": [keyshop_low(499), steam_low(999)]}]
        )
        assert client.fetch_steam_lows([SILKSONG])[1030300].low == Money(999, "EUR")

    def test_games_without_a_recorded_low_are_omitted(self) -> None:
        client, _ = make_client([{"id": "uuid-silksong", "lows": []}])
        assert client.fetch_steam_lows([SILKSONG]) == {}

    def test_unknown_ids_in_the_response_are_ignored(self) -> None:
        client, _ = make_client([{"id": "uuid-unrequested", "lows": [steam_low(999)]}])
        assert client.fetch_steam_lows([SILKSONG]) == {}

    def test_empty_input_makes_no_request(self) -> None:
        client, http = make_client()
        assert client.fetch_steam_lows([]) == {}
        assert http.calls == []

    def test_malformed_price_is_skipped_without_failing_the_batch(self) -> None:
        broken = steam_low(999)
        broken["price"] = {"amountInt": "not-an-int", "currency": "EUR"}
        client, _ = make_client(
            [
                {"id": "uuid-silksong", "lows": [broken]},
                {"id": "uuid-cyberpunk", "lows": [steam_low(1999)]},
            ]
        )

        lows = client.fetch_steam_lows([SILKSONG, CYBERPUNK])
        assert set(lows) == {1091500}

    def test_missing_timestamp_is_tolerated(self) -> None:
        entry = steam_low(999)
        del entry["timestamp"]
        client, _ = make_client([{"id": "uuid-silksong", "lows": [entry]}])

        assert client.fetch_steam_lows([SILKSONG])[1030300].recorded_at is None

    def test_unexpected_payload_shape_yields_no_lows(self) -> None:
        client, _ = make_client({"not": "a list"})
        assert client.fetch_steam_lows([SILKSONG]) == {}

    def test_requests_are_split_into_batches(self) -> None:
        identities = [
            GameIdentity(app_id=i, itad_id=f"uuid-{i}", title=f"Game {i}")
            for i in range(STORELOW_BATCH_SIZE + 5)
        ]
        client, http = make_client([], [])

        client.fetch_steam_lows(identities)

        assert len(http.calls) == 2
        assert len(http.calls[0]["payload"]) == STORELOW_BATCH_SIZE
        assert len(http.calls[1]["payload"]) == 5
