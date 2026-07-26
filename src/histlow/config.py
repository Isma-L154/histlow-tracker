"""Loading and validation of settings from the environment and `config.json`.

The split is deliberate and security-relevant:

* `config.json` holds behaviour. It is committed, reviewable in a diff, and
  contains nothing sensitive.
* The environment holds identity. It is never committed and is supplied by
  GitHub Actions secrets in CI.

Validation is strict and happens once, at startup. A malformed configuration
must fail loudly and immediately rather than surface later as an empty result
set that looks indistinguishable from "no deals today".
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

DEFAULT_CONFIG_FILENAME = "config.json"

_STEAM_ID64_LENGTH = 17
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


class ConfigError(RuntimeError):
    """Raised when settings are missing, malformed or mutually inconsistent."""


@dataclass(frozen=True, slots=True)
class Secrets:
    """Identity material. Never logged, never serialised, never committed."""

    steam_id64: str
    itad_api_key: str
    gist_id: str
    gist_token: str

    def redactable_values(self) -> tuple[str, ...]:
        """Values to seed the log redaction filter with."""
        candidates = (self.steam_id64, self.itad_api_key, self.gist_id, self.gist_token)
        return tuple(value for value in candidates if value)

    def require_publishing_credentials(self) -> None:
        """Guards the publish step; both values are optional until then.

        The gist is created by `scripts/bootstrap_gist.py`, so a first
        `--dry-run` has to be possible before these exist.
        """
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

    def __repr__(self) -> str:  # pragma: no cover - defensive only
        """Prevents an accidental `print(settings)` from dumping credentials."""
        return "Secrets(<redacted>)"


@dataclass(frozen=True, slots=True)
class SaleWindow:
    """A date range during which the tracker polls more frequently."""

    name: str
    start: date
    end: date
    interval_hours: int

    def __post_init__(self) -> None:
        if self.end < self.start:
            raise ConfigError(f"sale window {self.name!r} ends before it starts")
        if not 1 <= self.interval_hours <= 24:
            raise ConfigError(
                f"sale window {self.name!r} has interval_hours={self.interval_hours}, expected 1-24"
            )

    def contains(self, day: date) -> bool:
        return self.start <= day <= self.end


@dataclass(frozen=True, slots=True)
class ScheduleConfig:
    """When a cron firing should escalate into a full run.

    GitHub Actions cron expressions are static, so the workflow fires on a
    fixed frequent cadence and this configuration decides which firings do real
    work. Changing the cadence therefore never requires editing YAML.
    """

    daily_run_hours_utc: tuple[int, ...]
    sale_windows: tuple[SaleWindow, ...] = ()

    def __post_init__(self) -> None:
        if not self.daily_run_hours_utc:
            raise ConfigError("schedule.daily_run_hours_utc must list at least one hour")
        for hour in self.daily_run_hours_utc:
            if not 0 <= hour <= 23:
                raise ConfigError(f"schedule hour out of range: {hour}")

    def active_window(self, day: date) -> SaleWindow | None:
        return next((w for w in self.sale_windows if w.contains(day)), None)


@dataclass(frozen=True, slots=True)
class AlertRules:
    """Thresholds governing which deals qualify and how often they re-alert."""

    min_discount_percent: int = 1
    reprice_threshold_minor: int = 1
    max_items_in_payload: int = 25

    def __post_init__(self) -> None:
        if not 0 <= self.min_discount_percent <= 100:
            raise ConfigError(
                f"alerts.min_discount_percent out of range: {self.min_discount_percent}"
            )
        if self.reprice_threshold_minor < 1:
            raise ConfigError("alerts.reprice_threshold_minor must be at least 1")
        if self.max_items_in_payload < 1:
            raise ConfigError("alerts.max_items_in_payload must be at least 1")


@dataclass(frozen=True, slots=True)
class NotificationConfig:
    """User-facing wording, kept out of the source so it can be any language.

    `headline_template` receives a single `{count}` placeholder. It is rendered
    once at load time so a typo fails at startup rather than at the moment an
    alert would have fired.
    """

    headline_template: str = "\U0001f4b8 {count} en minimo historico"
    separator: str = " · "
    #: Prefixed to games whose current sale beat every earlier price, as
    #: opposed to returning to a record set previously.
    record_marker: str = "\U0001f525 "

    def __post_init__(self) -> None:
        try:
            self.headline_template.format(count=0)
        except (IndexError, KeyError, ValueError) as exc:
            raise ConfigError(
                f"notification.headline_template is not a valid template ({exc}); "
                "the only supported placeholder is {count}"
            ) from exc


@dataclass(frozen=True, slots=True)
class StateConfig:
    """Retention policy for the de-duplication store."""

    retention_days: int = 180

    def __post_init__(self) -> None:
        if self.retention_days < 1:
            raise ConfigError("state.retention_days must be at least 1")


@dataclass(frozen=True, slots=True)
class Settings:
    """The fully validated configuration for one run."""

    secrets: Secrets
    country: str
    comparison_country: str
    log_level: str = "INFO"
    dry_run: bool = False
    schedule: ScheduleConfig = field(
        default_factory=lambda: ScheduleConfig(daily_run_hours_utc=(18,))
    )
    alerts: AlertRules = field(default_factory=AlertRules)
    notification: NotificationConfig = field(default_factory=NotificationConfig)
    state: StateConfig = field(default_factory=StateConfig)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_settings(env: Mapping[str, str], config_path: Path) -> Settings:
    """Builds :class:`Settings` from an environment mapping and a config file.

    `env` is injected rather than read from `os.environ` directly so tests can
    exercise every validation branch without mutating process state.
    """
    secrets, problems = _load_secrets(env)

    country = env.get("STORE_COUNTRY", "").strip().upper()
    if len(country) != 2 or not country.isalpha():
        problems.append(f"STORE_COUNTRY must be a 2-letter ISO 3166-1 code, got {country!r}")

    # ITAD does not carry price history for every currency Steam sells in; it
    # reports Costa Rica and Mexico in USD, for example. Comparing a colon
    # price against a dollar low is meaningless, so the at-or-below decision
    # runs in a region ITAD does track while prices are still shown in the
    # user's own. US is the safe default: ITAD always reports it in USD.
    comparison_country = env.get("COMPARISON_COUNTRY", "US").strip().upper()
    if len(comparison_country) != 2 or not comparison_country.isalpha():
        problems.append(
            f"COMPARISON_COUNTRY must be a 2-letter ISO 3166-1 code, got {comparison_country!r}"
        )

    if problems:
        raise ConfigError(
            "invalid configuration:\n  - " + "\n  - ".join(problems)
        )

    document = _read_config_file(config_path)

    return Settings(
        secrets=secrets,
        country=country,
        comparison_country=comparison_country,
        log_level=env.get("LOG_LEVEL", "INFO").strip().upper() or "INFO",
        dry_run=env.get("DRY_RUN", "").strip().lower() in _TRUE_VALUES,
        schedule=_parse_schedule(document.get("schedule", {})),
        alerts=_parse_alerts(document.get("alerts", {})),
        notification=_parse_notification(document.get("notification", {})),
        state=_parse_state(document.get("state", {})),
    )


def _load_secrets(env: Mapping[str, str]) -> tuple[Secrets, list[str]]:
    problems: list[str] = []

    steam_id = env.get("STEAM_ID64", "").strip()
    if not steam_id:
        problems.append("STEAM_ID64 is required")
    elif not (steam_id.isdigit() and len(steam_id) == _STEAM_ID64_LENGTH):
        # The value itself is withheld from the message: it is treated as a
        # secret and this error surfaces in CI logs.
        problems.append(f"STEAM_ID64 must be {_STEAM_ID64_LENGTH} digits")

    itad_key = env.get("ITAD_API_KEY", "").strip()
    if not itad_key:
        problems.append("ITAD_API_KEY is required")

    secrets = Secrets(
        steam_id64=steam_id,
        itad_api_key=itad_key,
        # Optional at load time; enforced by `require_publishing_credentials`.
        gist_id=env.get("GIST_ID", "").strip(),
        gist_token=env.get("GIST_TOKEN", "").strip(),
    )
    return secrets, problems


def _read_config_file(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8")
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


def _parse_schedule(section: Mapping) -> ScheduleConfig:
    hours = section.get("daily_run_hours_utc", [18])
    if not isinstance(hours, list) or not all(isinstance(h, int) for h in hours):
        raise ConfigError("schedule.daily_run_hours_utc must be a list of integers")

    windows = []
    for entry in section.get("sale_windows", []):
        if not isinstance(entry, Mapping):
            raise ConfigError("each schedule.sale_windows entry must be an object")
        try:
            windows.append(
                SaleWindow(
                    name=str(entry["name"]),
                    start=date.fromisoformat(str(entry["start"])),
                    end=date.fromisoformat(str(entry["end"])),
                    interval_hours=int(entry.get("interval_hours", 3)),
                )
            )
        except KeyError as exc:
            raise ConfigError(f"sale window missing required field: {exc}") from exc
        except ValueError as exc:
            raise ConfigError(f"sale window has an invalid date: {exc}") from exc

    return ScheduleConfig(daily_run_hours_utc=tuple(hours), sale_windows=tuple(windows))


def _parse_alerts(section: Mapping) -> AlertRules:
    defaults = AlertRules()
    return AlertRules(
        min_discount_percent=int(
            section.get("min_discount_percent", defaults.min_discount_percent)
        ),
        reprice_threshold_minor=int(
            section.get("reprice_threshold_minor", defaults.reprice_threshold_minor)
        ),
        max_items_in_payload=int(
            section.get("max_items_in_payload", defaults.max_items_in_payload)
        ),
    )


def _parse_notification(section: Mapping) -> NotificationConfig:
    defaults = NotificationConfig()
    return NotificationConfig(
        headline_template=str(section.get("headline_template", defaults.headline_template)),
        separator=str(section.get("separator", defaults.separator)),
        record_marker=str(section.get("record_marker", defaults.record_marker)),
    )


def _parse_state(section: Mapping) -> StateConfig:
    defaults = StateConfig()
    return StateConfig(retention_days=int(section.get("retention_days", defaults.retention_days)))
