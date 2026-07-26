"""IsThereAnyDeal adapter: identity resolution and Steam-specific price lows.

Two endpoints are used:

``GET /games/lookup/v1``
    Resolves a Steam app id to an ITAD game id and, usefully, its title. One
    app per request, which is why results are cached permanently.

``POST /games/storelow/v2``
    Returns the all-time lowest price per shop, up to 200 games per request.

Scoping the low to Steam is the decision the whole project depends on. The
generic ``/games/historylow/v1`` reports the lowest price across every shop
ITAD tracks; key resellers routinely undercut Steam, so a Steam price would
essentially never match that figure and the tracker would never fire.

The API key travels in the ``ITAD-API-Key`` header rather than the documented
``key`` query parameter, keeping it out of URLs entirely and therefore out of
any log line, proxy record or error message.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from datetime import datetime
from typing import Any

from .domain import ITAD_STEAM_SHOP_ID, DomainError, GameIdentity, HistoricalLow, Money
from .net import HttpClient, PermanentHttpError

log = logging.getLogger(__name__)

BASE_URL = "https://api.isthereanydeal.com"
LOOKUP_URL = f"{BASE_URL}/games/lookup/v1"
STORELOW_URL = f"{BASE_URL}/games/storelow/v2"

#: Documented maximum for the storelow request body.
STORELOW_BATCH_SIZE = 200

API_KEY_HEADER = "ITAD-API-Key"


class ItadError(RuntimeError):
    """Base class for ITAD adapter failures."""


class ItadAuthError(ItadError):
    """The API key was rejected. Retrying cannot help."""


class ItadClient:
    """Resolves game identities and their all-time Steam lows."""

    def __init__(self, http: HttpClient, api_key: str, country: str) -> None:
        self._http = http
        self._headers = {API_KEY_HEADER: api_key}
        self._country = country

    def lookup(self, app_id: int) -> GameIdentity | None:
        """Resolves one Steam app id, or None when ITAD does not carry it.

        A missing game is an ordinary outcome, not a failure: ITAD's catalogue
        does not cover every DLC, demo or regionally delisted title.
        """
        try:
            document = self._http.get_json(
                LOOKUP_URL, params={"appid": app_id}, headers=self._headers
            )
        except PermanentHttpError as exc:
            raise _classify_permanent(exc) from exc

        if not isinstance(document, dict) or not document.get("found"):
            return None

        game = document.get("game")
        if not isinstance(game, dict):
            return None

        itad_id = game.get("id")
        title = game.get("title")
        if not isinstance(itad_id, str) or not itad_id:
            log.warning("ITAD returned a game record without an id for app %d", app_id)
            return None

        return GameIdentity(
            app_id=app_id,
            itad_id=itad_id,
            title=title if isinstance(title, str) and title else f"App {app_id}",
        )

    def fetch_steam_lows(
        self, identities: Sequence[GameIdentity]
    ) -> dict[int, HistoricalLow]:
        """Returns the all-time Steam low per app id, keyed by Steam app id.

        Games absent from the result have no recorded Steam low and are simply
        not comparable; the caller skips them rather than guessing.
        """
        if not identities:
            return {}

        by_itad_id = {identity.itad_id: identity.app_id for identity in identities}
        lows: dict[int, HistoricalLow] = {}

        for batch in _chunked(list(by_itad_id), STORELOW_BATCH_SIZE):
            try:
                document = self._http.post_json(
                    STORELOW_URL,
                    payload=batch,
                    params={"country": self._country, "shops": str(ITAD_STEAM_SHOP_ID)},
                    headers=self._headers,
                )
            except PermanentHttpError as exc:
                raise _classify_permanent(exc) from exc

            lows.update(_parse_storelow_batch(document, by_itad_id))

        log.info("resolved %d Steam historical lows out of %d games", len(lows), len(identities))
        return lows


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_storelow_batch(
    document: Any, by_itad_id: dict[str, int]
) -> dict[int, HistoricalLow]:
    lows: dict[int, HistoricalLow] = {}
    if not isinstance(document, list):
        log.warning("storelow returned an unexpected payload shape; treating batch as unknown")
        return lows

    for record in document:
        if not isinstance(record, dict):
            continue
        app_id = by_itad_id.get(record.get("id"))
        if app_id is None:
            continue

        low = _extract_steam_low(app_id, record.get("lows"))
        if low is not None:
            lows[app_id] = low

    return lows


def _extract_steam_low(app_id: int, entries: Any) -> HistoricalLow | None:
    """Picks the Steam entry out of a `lows` array.

    The shop id is re-checked here even though the request already filtered on
    it. If that filter were ever ignored server-side, silently accepting a key
    reseller's low would make the tracker permanently silent - the exact
    failure this project is built to avoid - so the guarantee is enforced
    locally rather than trusted.
    """
    if not isinstance(entries, list):
        return None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        shop = entry.get("shop")
        if not isinstance(shop, dict) or shop.get("id") != ITAD_STEAM_SHOP_ID:
            continue

        price = entry.get("price")
        if not isinstance(price, dict):
            continue

        amount_int = price.get("amountInt")
        currency = price.get("currency")
        if not isinstance(amount_int, int) or not isinstance(currency, str):
            continue

        try:
            return HistoricalLow(
                app_id=app_id,
                low=Money(amount_int, currency.upper()),
                recorded_at=_parse_timestamp(entry.get("timestamp")),
            )
        except DomainError as exc:
            log.warning("app %d has an invalid historical low and was skipped: %s", app_id, exc)
            return None

    return None


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _classify_permanent(exc: PermanentHttpError) -> ItadError:
    if exc.status in (401, 403):
        # Deliberately does not echo the key or the URL: this message is
        # designed to be safe in a public CI log.
        return ItadAuthError(
            "ITAD rejected the API key. Confirm ITAD_API_KEY matches an application "
            "at https://isthereanydeal.com/apps/my/ and that the account email is verified."
        )
    return ItadError(str(exc))


def _chunked(items: Sequence[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield list(items[start : start + size])
