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
from dataclasses import dataclass
from datetime import datetime

from .domain import Deal, Money

PAYLOAD_VERSION = 1


@dataclass(frozen=True, slots=True)
class CurrencyFormat:
    """How one currency is conventionally written.

    `hide_zero_minor` covers currencies whose smallest denomination is not used
    in practice. Steam still reports colones in hundredths, so ₡15.000,00 is
    technically accurate but nobody writes it that way.
    """

    symbol: str
    symbol_leads: bool
    decimal_mark: str
    group_mark: str
    hide_zero_minor: bool = False


_FORMATS = {
    "EUR": CurrencyFormat("€", False, ",", "."),
    "GBP": CurrencyFormat("£", True, ".", ","),
    "USD": CurrencyFormat("$", True, ".", ","),
    "CRC": CurrencyFormat("₡", True, ",", ".", hide_zero_minor=True),
    "MXN": CurrencyFormat("$", True, ".", ","),
    "BRL": CurrencyFormat("R$", True, ",", "."),
    "ARS": CurrencyFormat("$", True, ",", ".", hide_zero_minor=True),
    "CLP": CurrencyFormat("$", True, ",", ".", hide_zero_minor=True),
    "COP": CurrencyFormat("$", True, ",", ".", hide_zero_minor=True),
}

#: Anything unlisted renders as `1234.56 XYZ`: unambiguous, if unpolished.
_FALLBACK = CurrencyFormat("", False, ".", ",")


def format_money(money: Money) -> str:
    """Renders an amount the way its region conventionally writes it.

    Display only. The integer minor units remain the single source of truth for
    every comparison; this string never feeds back into one.
    """
    spec = _FORMATS.get(money.currency, _FALLBACK)
    units, minor = divmod(money.minor_units, 100)

    number = f"{units:,}".replace(",", spec.group_mark)
    if not (spec.hide_zero_minor and minor == 0):
        number = f"{number}{spec.decimal_mark}{minor:02d}"

    if not spec.symbol:
        return f"{number} {money.currency}"
    return f"{spec.symbol}{number}" if spec.symbol_leads else f"{number} {spec.symbol}"


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
        # What the user pays, in their own storefront currency.
        "price": price,
        "price_minor": deal.current.minor_units,
        "currency": deal.current.currency,
        "regular_price": format_money(deal.regular),
        "discount_percent": deal.discount_percent,
        "is_new_record": deal.beats_previous_low,
        "low_recorded_at": deal.low_recorded_at.isoformat() if deal.low_recorded_at else None,
        "url": deal.store_url,
        "summary": f"{deal.title} {price}",
        # The pair the decision was actually made on. Exposed so the payload
        # can be audited without re-running the pipeline, and flagged when it
        # is a different currency than the one displayed.
        "reference_price": format_money(deal.reference_current),
        "reference_low": format_money(deal.reference_low),
        "reference_currency": deal.reference_current.currency,
        "compared_across_regions": deal.is_cross_region,
    }
