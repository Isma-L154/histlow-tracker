"""Steam storefront adapter: wishlist contents and current prices.

`IWishlistService/GetWishlist` lists app ids. `appdetails` accepts a batch of
ids only with `filters=price_overview`, which drops the name (`filters=basic`
rejects a batch with HTTP 400), so titles come from ITAD instead.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from typing import Any

from .domain import DomainError, Money, PriceQuote
from .net import HttpClient

log = logging.getLogger(__name__)

WISHLIST_URL = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/"
APPDETAILS_URL = "https://store.steampowered.com/api/appdetails"

#: Verified against the live endpoint. Steam allows ~200 requests per five minutes per IP.
PRICE_BATCH_SIZE = 30


class SteamError(RuntimeError):
    """Base class for Steam adapter failures."""


class WishlistUnavailableError(SteamError):
    """The wishlist could not be read, most often because it is not public."""


class SteamClient:
    """Reads wishlist membership and live prices for one storefront region."""

    def __init__(self, http: HttpClient, country: str) -> None:
        self._http = http
        self._country = country

    def fetch_wishlist(self, steam_id64: str) -> list[int]:
        """Returns the wishlisted app ids.

        Steam answers a private profile with HTTP 200 and an empty object, so that
        is raised rather than read as an empty wishlist and a silent tracker.
        """
        document = self._http.get_json(WISHLIST_URL, params={"steamid": steam_id64})
        response = _as_mapping(document.get("response"))

        if "items" not in response:
            raise WishlistUnavailableError(
                "Steam returned an empty wishlist payload. The profile's Game details "
                "privacy setting must be Public, and the wishlist must not be empty. "
                "Check https://steamcommunity.com/my/edit/settings"
            )

        app_ids = [
            app_id for item in response["items"] if (app_id := _wishlist_app_id(item)) is not None
        ]
        log.info("wishlist contains %d apps", len(app_ids))
        return app_ids

    def fetch_price_quotes(self, app_ids: Sequence[int]) -> dict[int, PriceQuote]:
        """Current prices by app id. Free, unreleased and region-locked apps carry none."""
        quotes: dict[int, PriceQuote] = {}

        for batch in _chunked(app_ids, PRICE_BATCH_SIZE):
            document = self._http.get_json(
                APPDETAILS_URL,
                params={
                    "appids": ",".join(str(app_id) for app_id in batch),
                    "filters": "price_overview",
                    "cc": self._country,
                },
            )
            quotes.update(_parse_price_batch(document))

        log.info("resolved %d priced apps out of %d requested", len(quotes), len(app_ids))
        return quotes


def _wishlist_app_id(item: Any) -> int | None:
    if not isinstance(item, dict):
        return None
    app_id = _coerce_int(item.get("appid"), default=None)
    if app_id is None:
        log.debug("skipping malformed wishlist item")
    return app_id


def _parse_price_batch(document: Any) -> dict[int, PriceQuote]:
    quotes: dict[int, PriceQuote] = {}
    if not isinstance(document, dict):
        log.warning("appdetails returned an unexpected payload shape; treating batch as unpriced")
        return quotes

    for key, entry in document.items():
        app_id = _coerce_int(key, default=None)
        if app_id is None or not isinstance(entry, dict) or not entry.get("success"):
            continue

        # Free-to-play apps answer with `"data": []`, an array rather than an object.
        data = entry.get("data")
        if not isinstance(data, dict):
            continue

        quote = _parse_price_overview(app_id, data.get("price_overview"))
        if quote is not None:
            quotes[app_id] = quote

    return quotes


def _parse_price_overview(app_id: int, overview: Any) -> PriceQuote | None:
    if not isinstance(overview, dict):
        return None

    currency = overview.get("currency")
    final = _coerce_int(overview.get("final"), default=None)
    initial = _coerce_int(overview.get("initial"), default=None)
    if not isinstance(currency, str) or final is None or initial is None:
        log.debug("app %d has an incomplete price_overview; skipping", app_id)
        return None

    try:
        return PriceQuote(
            app_id=app_id,
            current=Money(final, currency.upper()),
            regular=Money(initial, currency.upper()),
            discount_percent=_coerce_int(overview.get("discount_percent"), default=0),
        )
    except DomainError as exc:
        # One malformed entry must not abort the run for every other game.
        log.warning("app %d has an invalid price and was skipped: %s", app_id, exc)
        return None


def _chunked(items: Sequence[int], size: int) -> Iterator[Sequence[int]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _as_mapping(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _coerce_int(value: Any, default: int | None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
