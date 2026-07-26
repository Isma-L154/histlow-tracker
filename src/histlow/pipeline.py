"""Wires the adapters and the decision logic into one run.

This is the only module that knows about all the others. Everything it calls is
either a pure function or an adapter behind a narrow interface, so the ordering
below is the entire control flow of the project:

    wishlist -> prices -> discount filter -> identities -> historical lows
             -> at-or-below filter -> de-duplication -> publish

The discount filter placement is the optimisation the design rests on. For a
typical wishlist it removes roughly three quarters of the entries before any
historical data is requested.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import selector
from .cache import IdentityCache
from .config import Settings
from .domain import GameIdentity, PriceQuote
from .itad import ItadClient
from .net import HttpClient
from .payload import build_payload
from .publisher import DryRunPublisher, GistPublisher, Publisher
from .scheduling import decide
from .state import TrackerState
from .steam import SteamClient

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Paths:
    """Locations of the two files carried between runs by the Actions cache."""

    state: Path
    identities: Path

    @classmethod
    def under(cls, directory: Path) -> Paths:
        return cls(state=directory / "state.json", identities=directory / "identities.json")


@dataclass(frozen=True, slots=True)
class RunResult:
    """A structured summary of what happened, used for logging and tests."""

    ran: bool
    reason: str
    wishlist_size: int = 0
    discounted: int = 0
    qualifying: int = 0
    alerted: int = 0
    published_url: str = ""

    def describe(self) -> str:
        if not self.ran:
            return f"skipped: {self.reason}"
        return (
            f"{self.wishlist_size} wishlisted -> {self.discounted} discounted -> "
            f"{self.qualifying} at all-time low -> {self.alerted} newly alerted"
        )


def run(
    settings: Settings,
    *,
    paths: Paths,
    now: datetime,
    forced: bool = False,
    http: HttpClient | None = None,
) -> RunResult:
    """Executes one full tracker run and returns what it did."""
    state = TrackerState.load(paths.state)

    decision = decide(
        now=now, schedule=settings.schedule, last_run_at=state.last_run_at, forced=forced
    )
    if not decision.should_run:
        log.info("no work this firing (%s)", decision.reason)
        return RunResult(ran=False, reason=decision.reason)

    if decision.window_name:
        log.info("running inside sale window %r (%s)", decision.window_name, decision.reason)
    else:
        log.info("running (%s)", decision.reason)

    http = http or HttpClient()
    steam = SteamClient(http, country=settings.country)
    # Historical lows and the prices they are compared against must come from
    # the same region, or the currencies will not line up.
    reference_steam = SteamClient(http, country=settings.comparison_country)
    itad = ItadClient(
        http, api_key=settings.secrets.itad_api_key, country=settings.comparison_country
    )
    cache = IdentityCache.load(paths.identities)

    try:
        result = _execute(
            settings=settings,
            steam=steam,
            reference_steam=reference_steam,
            itad=itad,
            cache=cache,
            state=state,
            now=now,
            publisher=_build_publisher(settings, http),
            reason=decision.reason,
        )
    finally:
        # Lookups already performed are valid work even if a later stage
        # failed; persisting them keeps the next attempt cheap.
        cache.save()

    state.mark_run(now)
    state.purge_expired(retention=timedelta(days=settings.state.retention_days), now=now)
    state.save()

    return result


def _execute(
    *,
    settings: Settings,
    steam: SteamClient,
    reference_steam: SteamClient,
    itad: ItadClient,
    cache: IdentityCache,
    state: TrackerState,
    now: datetime,
    publisher: Publisher,
    reason: str,
) -> RunResult:
    wishlist = steam.fetch_wishlist(settings.secrets.steam_id64)
    quotes = steam.fetch_price_quotes([entry.app_id for entry in wishlist])

    discounted = selector.discounted_app_ids(quotes, settings.alerts)
    log.info("%d of %d wishlisted apps are discounted", len(discounted), len(wishlist))

    identities = _resolve_identities(itad, cache, discounted, now=now)
    lows = itad.fetch_steam_lows(list(identities.values()))

    store_quotes = {app_id: quotes[app_id] for app_id in discounted}
    reference_quotes = _reference_quotes(
        settings, reference_steam, store_quotes, discounted
    )

    qualifying = selector.qualifying_deals(store_quotes, reference_quotes, identities, lows)
    log.info("%d discounted apps are at or below their all-time Steam low", len(qualifying))

    fresh = selector.unreported_deals(qualifying, state, settings.alerts)
    ranked = selector.rank_for_payload(fresh, settings.alerts)

    payload = build_payload(
        ranked,
        generated_at=now,
        headline_template=settings.notification.headline_template,
        separator=settings.notification.separator,
    )
    published_url = publisher.publish(payload)

    # Recorded only after a successful publish. Marking them earlier would
    # suppress the alert permanently if publishing had failed.
    for deal in ranked:
        state.record_alert(deal.app_id, deal.current, now=now)

    return RunResult(
        ran=True,
        reason=reason,
        wishlist_size=len(wishlist),
        discounted=len(discounted),
        qualifying=len(qualifying),
        alerted=len(ranked),
        published_url=published_url,
    )


def _reference_quotes(
    settings: Settings,
    reference_steam: SteamClient,
    store_quotes: dict[int, PriceQuote],
    discounted: list[int],
) -> dict[int, PriceQuote]:
    """Prices in the comparison region, for the at-or-below decision.

    When both regions are the same the store prices already are the reference
    prices, so the second request is skipped entirely. Only a user whose
    currency ITAD does not track pays for the extra call, and only for the
    handful of games that survived the discount filter.
    """
    if settings.comparison_country == settings.country:
        return store_quotes
    if not discounted:
        return {}

    log.info(
        "fetching %s reference prices for %d discounted apps (%s is not tracked by ITAD)",
        settings.comparison_country,
        len(discounted),
        settings.country,
    )
    return reference_steam.fetch_price_quotes(discounted)


def _resolve_identities(
    itad: ItadClient,
    cache: IdentityCache,
    app_ids: list[int],
    *,
    now: datetime,
) -> dict[int, GameIdentity]:
    """Maps app ids to ITAD identities, querying only what is not cached."""
    identities: dict[int, GameIdentity] = {}
    looked_up = 0

    for app_id in app_ids:
        if cache.knows(app_id, now=now):
            cached = cache.get(app_id, now=now)
            if cached is not None:
                identities[app_id] = cached
            continue

        looked_up += 1
        identity = itad.lookup(app_id)
        if identity is None:
            # Remembered as a miss so an app ITAD does not carry is not
            # re-queried on every run.
            cache.remember_missing(app_id, now=now)
            log.debug("ITAD does not carry app %d; skipping", app_id)
            continue

        cache.remember(identity, now=now)
        identities[app_id] = identity

    log.info("resolved %d identities (%d required a lookup)", len(identities), looked_up)
    return identities


def _build_publisher(settings: Settings, http: HttpClient) -> Publisher:
    if settings.dry_run:
        return DryRunPublisher()

    settings.secrets.require_publishing_credentials()
    return GistPublisher(
        http, token=settings.secrets.gist_token, gist_id=settings.secrets.gist_id
    )
