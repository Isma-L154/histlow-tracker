"""Renders the JSON document the iOS Shortcut reads.

Everything the phone shows is computed here, where it can be tested, rather
than assembled from Shortcuts actions, where it cannot.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from .domain import Deal, Money

PAYLOAD_VERSION = 1


@dataclass(frozen=True, slots=True)
class CurrencyFormat:
    symbol: str
    symbol_leads: bool
    decimal_mark: str
    group_mark: str
    #: For currencies whose cents nobody writes: Steam reports ₡15.000,00, people write ₡15.000.
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

#: Anything unlisted renders as `1234.56 XYZ`.
_FALLBACK = CurrencyFormat("", False, ".", ",")


def format_money(money: Money) -> str:
    """Display only; every comparison uses the integer minor units."""
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
    record_marker: str = "",
) -> dict:
    """The document published to the gist.

    Published even with no deals, so a fresh `generated_at` tells "nothing on
    sale" apart from "the tracker stopped".
    """
    rendered = [_render_deal(deal, record_marker) for deal in deals]

    document = {
        "version": PAYLOAD_VERSION,
        "generated_at": generated_at.isoformat(),
        "count": len(rendered),
        "new_record_count": sum(1 for item in rendered if item["is_new_record"]),
        "deals": rendered,
    }

    # Absent, not empty, when there is nothing to report: Shortcuts will not
    # reliably compare numbers, so its trigger is "if headline has any value".
    if rendered:
        document["headline"] = headline_template.format(count=len(rendered))
        document["summary"] = separator.join(item["summary"] for item in rendered)
        document["alert_id"] = _alert_id(rendered)

    return document


def _alert_id(rendered: Sequence[dict]) -> str:
    """A fingerprint of the games and prices announced, so the Shortcut can skip repeats.

    Excludes `generated_at`, or every republication would look like a new alert.
    """
    fingerprint = ";".join(
        sorted(f"{item['app_id']}:{item['price_minor']}:{item['currency']}" for item in rendered)
    )
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:12]


def _render_deal(deal: Deal, record_marker: str) -> dict:
    price = format_money(deal.current)
    marker = record_marker if deal.record.sets_new_record else ""
    return {
        "app_id": deal.app_id,
        "title": deal.title,
        "price": price,
        "price_minor": deal.current.minor_units,
        "currency": deal.current.currency,
        "regular_price": format_money(deal.regular),
        "discount_percent": deal.discount_percent,
        "is_new_record": deal.record.sets_new_record,
        "previous_low": (
            format_money(deal.record.previous_low) if deal.record.previous_low else None
        ),
        "low_recorded_at": deal.low_recorded_at.isoformat() if deal.low_recorded_at else None,
        "url": deal.store_url,
        "summary": f"{marker}{deal.title} {price}",
        # The comparison-region pair the decision was made on, for auditing.
        "reference_price": format_money(deal.reference_current),
        "reference_low": format_money(deal.reference_low),
        "reference_currency": deal.reference_current.currency,
        "compared_across_regions": deal.is_cross_region,
    }
