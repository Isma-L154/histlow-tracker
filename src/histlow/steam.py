"""Steam storefront adapter: wishlist contents and current prices.

Two endpoints are used, both public and unauthenticated:

``IWishlistService/GetWishlist/v1``
    Returns app ids only. The legacy ``/wishlist/profiles/<id>/wishlistdata/``
    route this replaced is deprecated and is deliberately not used.

``store.steampowered.com/api/appdetails``
    Accepts a batch of app ids only when the response is narrowed with
    ``filters=price_overview``. That projection drops the game name, which is
    why titles come from ITAD instead. Verified behaviour:
    ``filters=basic`` rejects multi-id requests with HTTP 400, and a single-id
    request returns roughly 12 KB per game.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime
from typing import Any

from .domain import DomainError, Money, PriceQuote, WishlistEntry
from .net import HttpClient

log = logging.getLogger(__name__)

WISHLIST_URL = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/"
APPDETAILS_URL = "https://store.steampowered.com/api/appdetails"

#: Verified to succeed at this size against the live endpoint. Steam applies a
#: per-IP budget of roughly 200 requests per five minutes, so batching is what
#: keeps a large wishlist inside the limit.
PRICE_BATCH_SIZE = 30


class SteamError(RuntimeError):
    """Base class for Steam adapter failures."""


class WishlistUnavailableError(SteamError):
    """The wishlist could not be read, most often because it is not public."""


class SteamClient:
    """Reads wishlist membership and live prices for a single storefront region."""

    def __init__(self, http: HttpClient, country: str) -> None:
        self._http = http
        self._country = country

    def fetch_wishlist(self, steam_id64: str) -> list[WishlistEntry]:
        """Returns every app on the wishlist.

        Steam answers a private or non-existent profile with HTTP 200 and an
        empty object rather than an error status. Treating that as "no games"
        would turn a misconfigured profile into a permanently silent tracker,
        so it is raised as a failure with an actionable message instead.
        """
        document = self._http.get_json(WISHLIST_URL, params={"steamid": steam_id64})
        response = _as_mapping(document.get("response"))

        if "items" not in response:
            raise WishlistUnavailableError(
                "Steam returned an empty wishlist payload. The profile's Game details "
                "privacy setting must be Public, and the wishlist must not be empty. "
                "Check https://steamcommunity.com/my/edit/settings"
            )

        entries = [entry for item in response["items"] if (entry := _parse_wishlist_item(item))]
        log.info("wishlist contains %d apps", len(entries))
        return entries

    def fetch_price_quotes(self, app_ids: Sequence[int]) -> dict[int, PriceQuote]:
        """Returns current prices keyed by app id, skipping anything unpriced.

        Batches are issued sequentially. A wishlist of this project's expected
        size resolves in a single request, and sequential issue keeps the
        failure semantics obvious; concurrency would buy nothing measurable.

        Apps absent from the result are silently unpriced rather than errors:
        free-to-play titles, unreleased games and region-locked entries all
        legitimately carry no price.
        """
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


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_wishlist_item(item: Any) -> WishlistEntry | None:
    if not isinstance(item, dict):
        return None
    try:
        app_id = int(item["appid"])
    except (KeyError, TypeError, ValueError):
        log.debug("skipping malformed wishlist item")
        return None

    return WishlistEntry(
        app_id=app_id,
        added_at=_epoch_to_datetime(item.get("date_added")),
        priority=_coerce_int(item.get("priority"), default=0),
    )


def _parse_price_batch(document: Any) -> dict[int, PriceQuote]:
    quotes: dict[int, PriceQuote] = {}
    if not isinstance(document, dict):
        log.warning("appdetails returned an unexpected payload shape; treating batch as unpriced")
        return quotes

    for key, entry in document.items():
        app_id = _coerce_int(key, default=None)
        if app_id is None or not isinstance(entry, dict) or not entry.get("success"):
            continue

        # Free-to-play apps answer with `"data": []` - a JSON array, not an
        # object - so the type check here is load-bearing, not defensive noise.
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
            discount_percent=_coerce_int(overview.get("discount_percent"), default=0) or 0,
        )
    except DomainError as exc:
        # A single malformed entry must not abort the run for every other game.
        log.warning("app %d has an invalid price and was skipped: %s", app_id, exc)
        return None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _chunked(items: Sequence[int], size: int) -> Iterator[Sequence[int]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _as_mapping(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _coerce_int(value: Any, default: int | None) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _epoch_to_datetime(value: Any) -> datetime | None:
    seconds = _coerce_int(value, default=None)
    if seconds is None:
        return None
    try:
        return datetime.fromtimestamp(seconds, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None
