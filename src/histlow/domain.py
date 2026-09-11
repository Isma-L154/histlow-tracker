"""Immutable value objects, free of I/O so the decision logic tests without a network."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

STEAM_APP_URL_TEMPLATE = "https://store.steampowered.com/app/{app_id}"


class DomainError(ValueError):
    """A value object was constructed from inconsistent data."""


@dataclass(frozen=True, slots=True)
class Money:
    """An amount in integer minor units, never a float.

    The tracker's core test is `current <= low`, which binary floating point
    cannot answer reliably. Ordering across currencies raises; `>` and `>=`
    reach the guarded `__lt__` and `__le__` by reflection.
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


@dataclass(frozen=True, slots=True)
class PriceQuote:
    """The live Steam price for one app.

    No title: `appdetails` batches only with `filters=price_overview`, which
    drops the name. Titles come from ITAD instead.
    """

    app_id: int
    current: Money
    regular: Money
    discount_percent: int

    def __post_init__(self) -> None:
        self.current._guard_same_currency(self.regular)
        if not 0 <= self.discount_percent <= 100:
            raise DomainError(f"discount out of range: {self.discount_percent}")


@dataclass(frozen=True, slots=True)
class GameIdentity:
    """A Steam app id and its ITAD record."""

    app_id: int
    itad_id: str
    title: str


@dataclass(frozen=True, slots=True)
class HistoricalLow:
    """The all-time lowest price for one app, on Steam specifically."""

    app_id: int
    low: Money
    recorded_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class PricePoint:
    price: Money
    recorded_at: datetime


@dataclass(frozen=True, slots=True)
class RecordStatus:
    """Whether the current sale set the all-time low, or only matched an older one."""

    sets_new_record: bool
    previous_low: Money | None = None

    @classmethod
    def unknown(cls) -> RecordStatus:
        """History could not be loaded, so no record is claimed."""
        return cls(sets_new_record=False)


@dataclass(frozen=True, slots=True)
class Deal:
    """A game priced at or below its all-time Steam low.

    `current` and `regular` are the store region: what the user pays and sees.
    `reference_current` and `reference_low` are the region the decision was
    made in, because ITAD does not track every currency Steam sells in.
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
        return self.current.currency != self.reference_current.currency
