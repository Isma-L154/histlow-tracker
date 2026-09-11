"""IsThereAnyDeal adapter: identity lookup, all-time Steam lows and price history.

The low is scoped to Steam. The cross-shop low is set by key resellers, which a
Steam price would essentially never match, so the tracker would never fire.
The API key travels in a header, which keeps it out of URLs and therefore logs.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from datetime import datetime
from typing import Any

from .domain import DomainError, GameIdentity, HistoricalLow, Money, PricePoint
from .net import HttpClient, HttpError, PermanentHttpError

log = logging.getLogger(__name__)

BASE_URL = "https://api.isthereanydeal.com"
LOOKUP_URL = f"{BASE_URL}/games/lookup/v1"
STORELOW_URL = f"{BASE_URL}/games/storelow/v2"
HISTORY_URL = f"{BASE_URL}/games/history/v2"

#: Steam's shop id at ITAD, per `GET /service/shops/v1`.
STEAM_SHOP_ID = 61

#: Documented maximum for the storelow request body.
STORELOW_BATCH_SIZE = 200

API_KEY_HEADER = "ITAD-API-Key"


class ItadError(RuntimeError):
    """Base class for ITAD adapter failures."""


class ItadAuthError(ItadError):
    """The API key was rejected. Retrying cannot help."""


class ItadClient:
    def __init__(self, http: HttpClient, api_key: str, country: str) -> None:
        self._http = http
        self._headers = {API_KEY_HEADER: api_key}
        self._country = country

    def lookup(self, app_id: int) -> GameIdentity | None:
        """Resolves one Steam app id; None when ITAD does not carry it, as with many DLC."""
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

    def fetch_steam_lows(self, identities: Sequence[GameIdentity]) -> dict[int, HistoricalLow]:
        """The all-time Steam low per app id; apps without one are absent."""
        if not identities:
            return {}

        by_itad_id = {identity.itad_id: identity.app_id for identity in identities}
        lows: dict[int, HistoricalLow] = {}

        for batch in _chunked(list(by_itad_id), STORELOW_BATCH_SIZE):
            try:
                document = self._http.post_json(
                    STORELOW_URL,
                    payload=batch,
                    params={"country": self._country, "shops": str(STEAM_SHOP_ID)},
                    headers=self._headers,
                )
            except PermanentHttpError as exc:
                raise _classify_permanent(exc) from exc

            lows.update(_parse_storelow_batch(document, by_itad_id))

        log.info("resolved %d Steam historical lows out of %d games", len(lows), len(identities))
        return lows

    def fetch_price_history(self, itad_id: str) -> list[PricePoint]:
        """The Steam price log for one game, or empty when it cannot be loaded.

        Failing soft keeps one game from aborting the run; its record status is
        then unknown, which `selector.record_setting_deals` drops.
        """
        try:
            document = self._http.get_json(
                HISTORY_URL,
                params={"id": itad_id, "country": self._country, "shops": str(STEAM_SHOP_ID)},
                headers=self._headers,
            )
        except HttpError as exc:
            log.warning("could not load price history: %s", exc)
            return []

        return _parse_history(document)


def _parse_history(document: Any) -> list[PricePoint]:
    if not isinstance(document, list):
        log.warning("price history returned an unexpected payload shape")
        return []

    points: list[PricePoint] = []
    for entry in document:
        if not isinstance(entry, dict):
            continue
        recorded_at = _parse_timestamp(entry.get("timestamp"))
        deal = entry.get("deal")
        if recorded_at is None or not isinstance(deal, dict):
            continue
        try:
            price = _parse_money(deal.get("price"))
        except DomainError:
            continue
        if price is not None:
            points.append(PricePoint(price=price, recorded_at=recorded_at))

    return points


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

    The shop is re-checked although the request filtered on it: accepting a key
    reseller's low, should the filter ever be ignored, would silence the tracker.
    """
    if not isinstance(entries, list):
        return None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        shop = entry.get("shop")
        if not isinstance(shop, dict) or shop.get("id") != STEAM_SHOP_ID:
            continue

        try:
            low = _parse_money(entry.get("price"))
        except DomainError as exc:
            log.warning("app %d has an invalid historical low and was skipped: %s", app_id, exc)
            return None
        if low is None:
            continue

        return HistoricalLow(
            app_id=app_id, low=low, recorded_at=_parse_timestamp(entry.get("timestamp"))
        )

    return None


def _parse_money(price: Any) -> Money | None:
    """Reads ITAD's `{"amountInt", "currency"}` shape; raises DomainError on a bad value."""
    if not isinstance(price, dict):
        return None
    amount = price.get("amountInt")
    currency = price.get("currency")
    if not isinstance(amount, int) or not isinstance(currency, str):
        return None
    return Money(amount, currency.upper())


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _classify_permanent(exc: PermanentHttpError) -> ItadError:
    if exc.status in (401, 403):
        # Safe for a public CI log: neither the key nor the URL is echoed.
        return ItadAuthError(
            "ITAD rejected the API key. Confirm ITAD_API_KEY matches an application "
            "at https://isthereanydeal.com/apps/my/ and that the account email is verified."
        )
    return ItadError(str(exc))


def _chunked(items: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]
