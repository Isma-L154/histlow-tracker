"""Wires the adapters and the decision logic into one run.

    wishlist -> prices -> discount filter -> identities -> historical lows
             -> at-or-below filter -> record filter -> de-duplication -> publish

Filtering to discounted games first is what keeps ITAD traffic small.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import selector
from .cache import IdentityCache
from .config import Settings
from .domain import Deal, GameIdentity, HistoricalLow, PriceQuote, RecordStatus
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
    """The two files the Actions cache carries between runs."""

    state: Path
    identities: Path

    @classmethod
    def under(cls, directory: Path) -> Paths:
        return cls(state=directory / "state.json", identities=directory / "identities.json")


@dataclass(frozen=True, slots=True)
class RunResult:
    ran: bool
    reason: str
    wishlist_size: int = 0
    discounted: int = 0
    qualifying: int = 0
    record_setting: int = 0
    alerted: int = 0
    repeated: int = 0

    def describe(self) -> str:
        if not self.ran:
            return f"skipped: {self.reason}"
        return (
            f"{self.wishlist_size} wishlisted -> {self.discounted} discounted -> "
            f"{self.qualifying} at all-time low -> {self.record_setting} beat it -> "
            f"{self.alerted} newly alerted, {self.repeated} still showing"
        )


def run(
    settings: Settings,
    *,
    paths: Paths,
    now: datetime,
    forced: bool = False,
    http: HttpClient | None = None,
) -> RunResult:
    state = TrackerState.load(paths.state)

    decision = decide(
        now=now, schedule=settings.schedule, last_run_at=state.last_run_at, forced=forced
    )
    if not decision.should_run:
        log.info("no work this firing (%s)", decision.reason)
        return RunResult(ran=False, reason=decision.reason)

    log.info("running (%s)", decision.reason)

    http = http or HttpClient()
    steam = SteamClient(http, country=settings.country)
    # Lows and the prices compared against them must share a region, or the currencies differ.
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
        # Lookups already paid for survive a later failure. Saved in a dry run
        # too: the cache cannot change which deals qualify.
        cache.save()

    if settings.dry_run:
        # Recording alerts here would make the next real run suppress what was previewed.
        log.info("dry run: alert state left untouched")
        return result

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
    quotes = steam.fetch_price_quotes(wishlist)

    discounted = selector.discounted_app_ids(quotes, settings.alerts)
    log.info("%d of %d wishlisted apps are discounted", len(discounted), len(wishlist))

    identities = _resolve_identities(itad, cache, discounted, now=now)
    lows = itad.fetch_steam_lows(list(identities.values()))

    store_quotes = {app_id: quotes[app_id] for app_id in discounted}
    reference_quotes = _reference_quotes(settings, reference_steam, store_quotes)

    at_low = selector.qualifying_deals(store_quotes, reference_quotes, identities, lows)
    log.info("%d discounted apps are at or below their all-time Steam low", len(at_low))
    # History runs only on this already-narrowed set, so it costs a handful of requests.
    at_low = selector.annotate_records(at_low, _record_statuses(itad, identities, lows, at_low))

    candidates = at_low
    if settings.alerts.require_new_record:
        candidates = selector.record_setting_deals(at_low)
        log.info("%d of %d beat their previous record", len(candidates), len(at_low))
        if matched := len(at_low) - len(candidates):
            log.info("%d were at their low but did not beat it", matched)

    fresh = selector.unreported_deals(candidates, state, settings.alerts)
    repeated = selector.repeated_deals(candidates, state, settings.alerts, now=now)
    ranked = selector.rank_for_payload([*fresh, *repeated], settings.alerts)

    publisher.publish(
        build_payload(
            ranked,
            generated_at=now,
            headline_template=settings.notification.headline_template,
            separator=settings.notification.separator,
            record_marker=settings.notification.record_marker,
        )
    )

    # Only after a successful publish, and only the fresh ones: re-recording a
    # repeat would push its window forward every run, so it would never age out.
    for deal in fresh:
        state.record_alert(deal.app_id, deal.current, now=now)

    return RunResult(
        ran=True,
        reason=reason,
        wishlist_size=len(wishlist),
        discounted=len(discounted),
        qualifying=len(at_low),
        record_setting=sum(1 for deal in at_low if deal.record.sets_new_record),
        alerted=len(fresh),
        repeated=len(repeated),
    )


def _record_statuses(
    itad: ItadClient,
    identities: Mapping[int, GameIdentity],
    lows: Mapping[int, HistoricalLow],
    deals: Sequence[Deal],
) -> dict[int, RecordStatus]:
    # Every deal already has an identity and a low: `qualifying_deals` skips the rest.
    return {
        deal.app_id: selector.classify_record(
            itad.fetch_price_history(identities[deal.app_id].itad_id), lows[deal.app_id]
        )
        for deal in deals
    }


def _reference_quotes(
    settings: Settings, reference_steam: SteamClient, store_quotes: dict[int, PriceQuote]
) -> dict[int, PriceQuote]:
    """Prices in the comparison region; no request when it is the store region."""
    if settings.comparison_country == settings.country:
        return store_quotes
    if not store_quotes:
        return {}

    log.info(
        "fetching %s reference prices for %d discounted apps (%s is not tracked by ITAD)",
        settings.comparison_country,
        len(store_quotes),
        settings.country,
    )
    return reference_steam.fetch_price_quotes(list(store_quotes))


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
            cached = cache.get(app_id)
            if cached is not None:
                identities[app_id] = cached
            continue

        looked_up += 1
        identity = itad.lookup(app_id)
        if identity is None:
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
