"""Settings from the environment (identity, never committed) and `config.json` (behaviour).

Validated once at startup, so a bad configuration fails loudly instead of
looking like a day with no deals.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, TypeVar

_STEAM_ID64_LENGTH = 17
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})

_Section = TypeVar("_Section")


class ConfigError(RuntimeError):
    """Settings are missing, malformed or mutually inconsistent."""


@dataclass(frozen=True, slots=True)
class Secrets:
    steam_id64: str
    itad_api_key: str
    gist_id: str
    gist_token: str

    def redactable_values(self) -> tuple[str, ...]:
        candidates = (self.steam_id64, self.itad_api_key, self.gist_id, self.gist_token)
        return tuple(value for value in candidates if value)

    def require_publishing_credentials(self) -> None:
        """Enforced only at publish time, so a first `--dry-run` works before the gist exists."""
        missing = [
            name
            for name, value in (("GIST_ID", self.gist_id), ("GIST_TOKEN", self.gist_token))
            if not value
        ]
        if missing:
            raise ConfigError(
                f"publishing requires {' and '.join(missing)}; "
                "run scripts/bootstrap_gist.py to create the gist, or pass --dry-run"
            )

    def __repr__(self) -> str:
        """Keeps an accidental `print(settings)` from dumping credentials."""
        return "Secrets(<redacted>)"


@dataclass(frozen=True, slots=True)
class ScheduleConfig:
    """Guards against doing the same work twice, such as a duplicated cron delivery."""

    #: The loosest value allowed. GitHub's delivery delay can land the two daily
    #: firings under 2h30m apart, and a wider gate would silently drop one.
    min_interval_hours: int = 1

    def __post_init__(self) -> None:
        if not 1 <= self.min_interval_hours <= 24:
            raise ConfigError(
                f"schedule.min_interval_hours must be 1-24, got {self.min_interval_hours}"
            )


@dataclass(frozen=True, slots=True)
class AlertRules:
    min_discount_percent: int = 1
    reprice_threshold_minor: int = 1
    max_items_in_payload: int = 25
    #: Days a reported deal stays in the payload, so a poll that missed it still sees it.
    repeat_for_days: int = 2
    #: Report only sales that beat every earlier price, not returns to an old record.
    require_new_record: bool = True

    def __post_init__(self) -> None:
        if not 0 <= self.min_discount_percent <= 100:
            raise ConfigError(
                f"alerts.min_discount_percent out of range: {self.min_discount_percent}"
            )
        if self.reprice_threshold_minor < 1:
            raise ConfigError("alerts.reprice_threshold_minor must be at least 1")
        if self.max_items_in_payload < 1:
            raise ConfigError("alerts.max_items_in_payload must be at least 1")
        if self.repeat_for_days < 0:
            raise ConfigError("alerts.repeat_for_days cannot be negative")


@dataclass(frozen=True, slots=True)
class NotificationConfig:
    """User-facing wording, kept out of the source so it can be in any language."""

    headline_template: str = "\U0001f525 {count} en nuevo minimo historico"
    separator: str = "\n"
    #: Prefixes record-setting games. Empty: `require_new_record` makes every one a record.
    record_marker: str = ""

    def __post_init__(self) -> None:
        # Rendered here so a template typo fails at startup, not when an alert fires.
        try:
            self.headline_template.format(count=0)
        except (IndexError, KeyError, ValueError) as exc:
            raise ConfigError(
                f"notification.headline_template is not a valid template ({exc}); "
                "the only supported placeholder is {count}"
            ) from exc


@dataclass(frozen=True, slots=True)
class StateConfig:
    retention_days: int = 180

    def __post_init__(self) -> None:
        if self.retention_days < 1:
            raise ConfigError("state.retention_days must be at least 1")


@dataclass(frozen=True, slots=True)
class Settings:
    secrets: Secrets
    country: str
    comparison_country: str
    log_level: str = "INFO"
    dry_run: bool = False
    schedule: ScheduleConfig = field(default_factory=ScheduleConfig)
    alerts: AlertRules = field(default_factory=AlertRules)
    notification: NotificationConfig = field(default_factory=NotificationConfig)
    state: StateConfig = field(default_factory=StateConfig)


def load_settings(env: Mapping[str, str], config_path: Path) -> Settings:
    secrets, problems = _load_secrets(env)

    country = env.get("STORE_COUNTRY", "").strip().upper()
    if len(country) != 2 or not country.isalpha():
        problems.append(f"STORE_COUNTRY must be a 2-letter ISO 3166-1 code, got {country!r}")

    # ITAD reports some regions (Costa Rica, Mexico) in USD, so the at-or-below
    # decision runs in a region it tracks while prices show in the user's own.
    comparison_country = env.get("COMPARISON_COUNTRY", "US").strip().upper()
    if len(comparison_country) != 2 or not comparison_country.isalpha():
        problems.append(
            f"COMPARISON_COUNTRY must be a 2-letter ISO 3166-1 code, got {comparison_country!r}"
        )

    if problems:
        raise ConfigError("invalid configuration:\n  - " + "\n  - ".join(problems))

    document = _read_config_file(config_path)

    return Settings(
        secrets=secrets,
        country=country,
        comparison_country=comparison_country,
        log_level=env.get("LOG_LEVEL", "INFO").strip().upper() or "INFO",
        dry_run=env.get("DRY_RUN", "").strip().lower() in _TRUE_VALUES,
        schedule=_parse_section(ScheduleConfig, document, "schedule"),
        alerts=_parse_section(AlertRules, document, "alerts"),
        notification=_parse_section(NotificationConfig, document, "notification"),
        state=_parse_section(StateConfig, document, "state"),
    )


def _load_secrets(env: Mapping[str, str]) -> tuple[Secrets, list[str]]:
    problems: list[str] = []

    steam_id = env.get("STEAM_ID64", "").strip()
    if not steam_id:
        problems.append("STEAM_ID64 is required")
    elif not (steam_id.isdigit() and len(steam_id) == _STEAM_ID64_LENGTH):
        # The value is withheld: it is treated as a secret, and this reaches CI logs.
        problems.append(f"STEAM_ID64 must be {_STEAM_ID64_LENGTH} digits")

    itad_key = env.get("ITAD_API_KEY", "").strip()
    if not itad_key:
        problems.append("ITAD_API_KEY is required")

    secrets = Secrets(
        steam_id64=steam_id,
        itad_api_key=itad_key,
        gist_id=env.get("GIST_ID", "").strip(),
        gist_token=env.get("GIST_TOKEN", "").strip(),
    )
    return secrets, problems


def _read_config_file(path: Path) -> dict:
    try:
        # utf-8-sig: Windows editors and PowerShell's Set-Content add a BOM json rejects.
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise ConfigError(f"configuration file not found: {path}") from exc
    except OSError as exc:
        raise ConfigError(f"could not read {path}: {exc}") from exc

    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} is not valid JSON: {exc}") from exc

    if not isinstance(document, dict):
        raise ConfigError(f"{path} must contain a JSON object at the top level")
    return document


def _parse_section(cls: type[_Section], document: Mapping[str, Any], name: str) -> _Section:
    """Builds one section, coercing each value to the type of its default."""
    section = document.get(name, {})
    defaults = cls()
    values = {}
    for spec in fields(cls):
        default = getattr(defaults, spec.name)
        try:
            values[spec.name] = type(default)(section.get(spec.name, default))
        except (TypeError, ValueError) as exc:
            raise ConfigError(
                f"{name}.{spec.name} must be {type(default).__name__}: {exc}"
            ) from exc
    return cls(**values)
