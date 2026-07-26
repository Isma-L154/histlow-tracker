"""Renders the JSON document the iOS Shortcut reads.

Pure functions only. The shape is chosen so that the Shortcut stays trivial:
it reads `count` to decide whether to notify, then shows `headline` as the
notification title and `summary` as its body. Everything a phone needs is
pre-computed here, where it can be unit tested, rather than assembled with
Shortcuts actions where it cannot.

`deals` carries the structured data as well, so the Shortcut can render a
richer list on tap without re-deriving anything.

User-facing wording is not hard-coded. The headline comes from a template in
`config.json`, keeping the source in English while the notification arrives in
whatever language the user configured.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from .domain import Deal, Money

PAYLOAD_VERSION = 1

#: Rendered before the amount for these currencies, after it for the rest.
_SYMBOL_PREFIX = {"USD": "$", "GBP": "£"}
_SYMBOL_SUFFIX = {"EUR": "€"}

#: Currencies conventionally written with a decimal comma.
_COMMA_DECIMAL = frozenset({"EUR"})


def format_money(money: Money) -> str:
    """Renders an amount the way its region conventionally writes it.

    Display only. The integer minor units remain the single source of truth for
    every comparison; this string never feeds back into one.
    """
    units, cents = divmod(money.minor_units, 100)
    separator = "," if money.currency in _COMMA_DECIMAL else "."
    number = f"{units}{separator}{cents:02d}"

    if money.currency in _SYMBOL_PREFIX:
        return f"{_SYMBOL_PREFIX[money.currency]}{number}"
    if money.currency in _SYMBOL_SUFFIX:
        return f"{number} {_SYMBOL_SUFFIX[money.currency]}"
    return f"{number} {money.currency}"


def build_payload(
    deals: Sequence[Deal],
    *,
    generated_at: datetime,
    headline_template: str,
    separator: str = " · ",
) -> dict:
    """Builds the complete document published to the gist.

    A run with no qualifying deals still publishes, with `count` at zero. The
    Shortcut therefore always reads a fresh, well-formed document and can tell
    "nothing on sale" apart from "the tracker has stopped working" by checking
    `generated_at`.
    """
    rendered = [_render_deal(deal) for deal in deals]

    return {
        "version": PAYLOAD_VERSION,
        "generated_at": generated_at.isoformat(),
        "count": len(rendered),
        "headline": headline_template.format(count=len(rendered)),
        "summary": separator.join(item["summary"] for item in rendered),
        "deals": rendered,
    }


def _render_deal(deal: Deal) -> dict:
    price = format_money(deal.current)
    return {
        "app_id": deal.app_id,
        "title": deal.title,
        "price": price,
        "price_minor": deal.current.minor_units,
        "currency": deal.current.currency,
        "regular_price": format_money(deal.regular),
        "discount_percent": deal.discount_percent,
        "historical_low": format_money(deal.historical_low),
        "is_new_record": deal.beats_previous_low,
        "low_recorded_at": deal.low_recorded_at.isoformat() if deal.low_recorded_at else None,
        "url": deal.store_url,
        "summary": f"{deal.title} {price}",
    }
