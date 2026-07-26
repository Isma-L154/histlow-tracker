"""Tests for settings loading and validation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from histlow.config import ConfigError, ScheduleConfig, Secrets, load_settings

VALID_ENV = {
    "STEAM_ID64": "76561198028121353",
    "STORE_COUNTRY": "es",
    "ITAD_API_KEY": "itad-key-value",
}

CONFIG_DOCUMENT = {
    "schedule": {"min_interval_hours": 3},
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
        assert settings.schedule.min_interval_hours == 3
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


class TestScheduleConfig:
    def test_the_default_matches_the_shipped_once_daily_cron(self) -> None:
        # Kept in step with config.json and the cron in tracker.yml, so a
        # missing schedule section behaves the same as the shipped one.
        assert ScheduleConfig().min_interval_hours == 20

    @pytest.mark.parametrize("hours", [0, -1, 25])
    def test_rejects_an_interval_outside_a_day(self, hours: int) -> None:
        with pytest.raises(ConfigError, match="min_interval_hours"):
            ScheduleConfig(min_interval_hours=hours)

    def test_a_missing_section_uses_the_default(self, tmp_path: Path) -> None:
        path = tmp_path / "config.json"
        path.write_text(json.dumps({}), encoding="utf-8")
        assert load_settings(VALID_ENV, path).schedule.min_interval_hours == 20

    def test_a_non_numeric_interval_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "config.json"
        path.write_text(json.dumps({"schedule": {"min_interval_hours": "soon"}}), encoding="utf-8")
        with pytest.raises(ConfigError, match="min_interval_hours"):
            load_settings(VALID_ENV, path)
