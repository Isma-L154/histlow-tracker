"""Core value objects for the tracker.

This module is deliberately free of I/O, logging and third-party imports.
Everything here is an immutable value that can be constructed in a test without
touching the network, which is what keeps the decision logic in `selector.py`
trivially verifiable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

STEAM_APP_URL_TEMPLATE = "https://store.steampowered.com/app/{app_id}"

#: IsThereAnyDeal's shop identifier for Steam, confirmed against
#: `GET /service/shops/v1`. Historical lows must be scoped to this shop;
#: the cross-shop low is dominated by key resellers and would never match.
ITAD_STEAM_SHOP_ID = 61


class DomainError(ValueError):
    """Raised when a value object is constructed from inconsistent data."""


@dataclass(frozen=True, slots=True, order=False)
class Money:
    """A currency amount stored as integer minor units.

    Prices are never represented as floats anywhere in this codebase. The
    tracker's entire purpose is an equality-sensitive comparison between a
    current price and an all-time low, and `14.99 <= 14.99` is not a guaranteed
    truth in binary floating point while `1499 <= 1499` always is.

    Ordering is defined only between amounts sharing a currency; comparing
    across currencies raises rather than returning a meaningless answer.
    """

    minor_units: int
    currency: str

    def __post_init__(self) -> None:
        if self.minor_units < 0:
            raise DomainError(f"price cannot be negative: {self.minor_units}")
        if len(self.currency) != 3 or not self.currency.isalpha():
            raise DomainError(f"currency must be a 3-letter ISO 4217 code: {self.currency!r}")
        if self.currency != self.currency.upper():
            raise DomainError(f"currency must be upper-case: {self.currency!r}")

    @classmethod
    def zero(cls, currency: str) -> Money:
        return cls(0, currency)

    def _guard_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise DomainError(
                f"refusing to compare {self.currency} against {other.currency}; "
                "a single storefront region must be configured"
            )

    def __lt__(self, other: Money) -> bool:
        self._guard_same_currency(other)
        return self.minor_units < other.minor_units

    def __le__(self, other: Money) -> bool:
        self._guard_same_currency(other)
        return self.minor_units <= other.minor_units

    def __gt__(self, other: Money) -> bool:
        return not self.__le__(other)

    def __ge__(self, other: Money) -> bool:
        return not self.__lt__(other)

    def __str__(self) -> str:
        """Render as a plain decimal string, e.g. `9.99 EUR`.

        Assumes a two-decimal currency, which holds for every region this
        tracker supports. Formatting is for humans only and never feeds back
        into a comparison.
        """
        units, cents = divmod(self.minor_units, 100)
        return f"{units}.{cents:02d} {self.currency}"


@dataclass(frozen=True, slots=True)
class WishlistEntry:
    """A single row of the user's wishlist as returned by Steam."""

    app_id: int
    added_at: datetime | None = None
    priority: int = 0


@dataclass(frozen=True, slots=True)
class PriceQuote:
    """The live Steam price for one app in the configured region.

    Carries no title on purpose. Steam's `appdetails` endpoint only accepts a
    batch of app ids when the response is narrowed to `filters=price_overview`,
    and that projection excludes the name. Titles are sourced from ITAD's
    lookup instead, which the pipeline performs anyway and caches forever.
    """

    app_id: int
    current: Money
    regular: Money
    discount_percent: int

    def __post_init__(self) -> None:
        self.current._guard_same_currency(self.regular)
        if not 0 <= self.discount_percent <= 100:
            raise DomainError(f"discount out of range: {self.discount_percent}")

    @property
    def is_discounted(self) -> bool:
        return self.discount_percent > 0


@dataclass(frozen=True, slots=True)
class GameIdentity:
    """The mapping between a Steam app id and its ITAD record.

    Resolution costs one request per game, so the pipeline caches this
    permanently: a given app is looked up once in the project's lifetime.
    """

    app_id: int
    itad_id: str
    title: str


@dataclass(frozen=True, slots=True)
class HistoricalLow:
    """The all-time lowest price recorded for one app on Steam specifically."""

    app_id: int
    low: Money
    recorded_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class PricePoint:
    """One entry in a game's Steam price history."""

    price: Money
    recorded_at: datetime


@dataclass(frozen=True, slots=True)
class RecordStatus:
    """Whether the current price run is the one that set the all-time low.

    Distinguishes the two ways a game can be at its record price, which the
    stores themselves label differently:

    * a *new* historical low, where this sale beat everything before it
    * *matching* a low set by some earlier sale

    Both are worth an alert - the price is the lowest it has ever been either
    way - but only the first is news.
    """

    sets_new_record: bool
    previous_low: Money | None = None

    @classmethod
    def unknown(cls) -> RecordStatus:
        """Used when history could not be loaded; never claims a record."""
        return cls(sets_new_record=False)


@dataclass(frozen=True, slots=True)
class Deal:
    """A qualifying find: currently priced at or below its all-time Steam low.

    Two currencies are carried on purpose, because they answer different
    questions.

    `current` and `regular` are the *store* region: what the user will actually
    pay, and therefore what the notification shows.

    `reference_current` and `reference_low` are the *comparison* region: the
    pair the at-or-below decision was made on. A separate region is needed
    because ITAD does not track every currency Steam sells in - it reports
    Costa Rica in USD, for instance - and comparing a colón price against a
    dollar low is meaningless.

    Both pairs are internally consistent; the invariants below enforce that.
    """

    app_id: int
    title: str
    current: Money
    regular: Money
    discount_percent: int
    reference_current: Money
    reference_low: Money
    low_recorded_at: datetime | None
    record: RecordStatus = field(default_factory=RecordStatus.unknown)

    def __post_init__(self) -> None:
        self.current._guard_same_currency(self.regular)
        self.reference_current._guard_same_currency(self.reference_low)

    @property
    def store_url(self) -> str:
        return STEAM_APP_URL_TEMPLATE.format(app_id=self.app_id)

    @property
    def is_cross_region(self) -> bool:
        """True when the decision was made in a different currency than shown."""
        return self.current.currency != self.reference_current.currency
