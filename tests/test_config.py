"""Tests for settings loading and validation."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from histlow.config import ConfigError, SaleWindow, ScheduleConfig, Secrets, load_settings

VALID_ENV = {
    "STEAM_ID64": "76561198028121353",
    "STORE_COUNTRY": "es",
    "ITAD_API_KEY": "itad-key-value",
}

CONFIG_DOCUMENT = {
    "schedule": {
        "daily_run_hours_utc": [18],
        "sale_windows": [
            {
                "name": "Winter Sale",
                "start": "2026-12-18",
                "end": "2027-01-05",
                "interval_hours": 3,
            }
        ],
    },
    "alerts": {"min_discount_percent": 1, "reprice_threshold_minor": 1, "max_items_in_payload": 25},
    "state": {"retention_days": 180},
}


@pytest.fixture
def config_file(tmp_path: Path) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(CONFIG_DOCUMENT), encoding="utf-8")
    return path


class TestLoadSettings:
    def test_loads_a_valid_configuration(self, config_file: Path) -> None:
        settings = load_settings(VALID_ENV, config_file)

        assert settings.country == "ES"  # normalised to upper case
        assert settings.secrets.steam_id64 == "76561198028121353"
        assert settings.dry_run is False
        assert settings.schedule.daily_run_hours_utc == (18,)
        assert settings.schedule.sale_windows[0].name == "Winter Sale"
        assert settings.state.retention_days == 180

    def test_reports_every_problem_at_once(self, config_file: Path) -> None:
        with pytest.raises(ConfigError) as excinfo:
            load_settings({"STEAM_ID64": "", "STORE_COUNTRY": "", "ITAD_API_KEY": ""}, config_file)

        message = str(excinfo.value)
        assert "STEAM_ID64" in message
        assert "ITAD_API_KEY" in message
        assert "STORE_COUNTRY" in message

    def test_never_echoes_the_steam_id_in_an_error(self, config_file: Path) -> None:
        bad = {**VALID_ENV, "STEAM_ID64": "1234"}
        with pytest.raises(ConfigError) as excinfo:
            load_settings(bad, config_file)
        assert "1234" not in str(excinfo.value)

    @pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
    def test_dry_run_accepts_common_truthy_spellings(self, config_file: Path, value: str) -> None:
        assert load_settings({**VALID_ENV, "DRY_RUN": value}, config_file).dry_run is True

    @pytest.mark.parametrize("value", ["0", "false", "no", "", "maybe"])
    def test_dry_run_defaults_to_publishing(self, config_file: Path, value: str) -> None:
        assert load_settings({**VALID_ENV, "DRY_RUN": value}, config_file).dry_run is False

    def test_missing_config_file_is_reported_clearly(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="not found"):
            load_settings(VALID_ENV, tmp_path / "absent.json")

    def test_malformed_json_is_reported_clearly(self, tmp_path: Path) -> None:
        path = tmp_path / "config.json"
        path.write_text("{ not json", encoding="utf-8")
        with pytest.raises(ConfigError, match="not valid JSON"):
            load_settings(VALID_ENV, path)

    def test_a_byte_order_mark_is_tolerated(self, tmp_path: Path) -> None:
        # Windows editors and PowerShell's Set-Content add one silently, and
        # json.loads rejects it outright.
        path = tmp_path / "config.json"
        path.write_bytes(b"\xef\xbb\xbf" + json.dumps(CONFIG_DOCUMENT).encode("utf-8"))

        assert load_settings(VALID_ENV, path).country == "ES"


class TestSecrets:
    def test_repr_does_not_leak(self) -> None:
        secrets = Secrets("76561198028121353", "itad-key", "gist-id", "gist-token")
        assert "itad-key" not in repr(secrets)
        assert repr(secrets) == "Secrets(<redacted>)"

    def test_redactable_values_skips_empties(self) -> None:
        secrets = Secrets("76561198028121353", "itad-key", "", "")
        assert secrets.redactable_values() == ("76561198028121353", "itad-key")

    def test_publishing_requires_both_gist_values(self) -> None:
        with pytest.raises(ConfigError, match="GIST_ID and GIST_TOKEN"):
            Secrets("76561198028121353", "itad-key", "", "").require_publishing_credentials()

    def test_publishing_passes_when_configured(self) -> None:
        Secrets("76561198028121353", "itad-key", "gid", "gtok").require_publishing_credentials()


class TestSaleWindow:
    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(ConfigError, match="ends before it starts"):
            SaleWindow("Broken", date(2026, 12, 5), date(2026, 12, 1), 3)

    def test_rejects_absurd_interval(self) -> None:
        with pytest.raises(ConfigError, match="interval_hours"):
            SaleWindow("Broken", date(2026, 12, 1), date(2026, 12, 5), 0)

    def test_boundaries_are_inclusive(self) -> None:
        window = SaleWindow("Winter", date(2026, 12, 18), date(2027, 1, 5), 3)
        assert window.contains(date(2026, 12, 18))
        assert window.contains(date(2027, 1, 5))
        assert not window.contains(date(2026, 12, 17))
        assert not window.contains(date(2027, 1, 6))


class TestScheduleConfig:
    def test_requires_at_least_one_daily_hour(self) -> None:
        with pytest.raises(ConfigError, match="at least one hour"):
            ScheduleConfig(daily_run_hours_utc=())

    def test_rejects_hours_outside_the_clock(self) -> None:
        with pytest.raises(ConfigError, match="out of range"):
            ScheduleConfig(daily_run_hours_utc=(24,))

    def test_active_window_finds_the_matching_range(self) -> None:
        winter = SaleWindow("Winter", date(2026, 12, 18), date(2027, 1, 5), 3)
        schedule = ScheduleConfig(daily_run_hours_utc=(18,), sale_windows=(winter,))
        assert schedule.active_window(date(2026, 12, 20)) is winter
        assert schedule.active_window(date(2026, 11, 1)) is None
