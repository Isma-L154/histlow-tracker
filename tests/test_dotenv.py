"""Tests for the minimal .env reader."""

from __future__ import annotations

from pathlib import Path

from histlow.dotenv import merge_environment, read_dotenv


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / ".env"
    path.write_text(content, encoding="utf-8")
    return path


class TestReadDotenv:
    def test_parses_simple_assignments(self, tmp_path: Path) -> None:
        path = write(tmp_path, "STEAM_ID64=76561199094002095\nSTORE_COUNTRY=ES\n")
        assert read_dotenv(path) == {
            "STEAM_ID64": "76561199094002095",
            "STORE_COUNTRY": "ES",
        }

    def test_skips_comments_and_blank_lines(self, tmp_path: Path) -> None:
        path = write(tmp_path, "# a comment\n\n  \nKEY=value\n")
        assert read_dotenv(path) == {"KEY": "value"}

    def test_strips_surrounding_quotes(self, tmp_path: Path) -> None:
        path = write(tmp_path, "A=\"double\"\nB='single'\nC=bare\n")
        assert read_dotenv(path) == {"A": "double", "B": "single", "C": "bare"}

    def test_keeps_inner_equals_signs(self, tmp_path: Path) -> None:
        path = write(tmp_path, "TOKEN=abc=def==\n")
        assert read_dotenv(path) == {"TOKEN": "abc=def=="}

    def test_trims_surrounding_whitespace(self, tmp_path: Path) -> None:
        path = write(tmp_path, "  KEY  =  value  \n")
        assert read_dotenv(path) == {"KEY": "value"}

    def test_an_empty_value_is_preserved(self, tmp_path: Path) -> None:
        path = write(tmp_path, "EMPTY=\n")
        assert read_dotenv(path) == {"EMPTY": ""}

    def test_a_missing_file_is_not_an_error(self, tmp_path: Path) -> None:
        assert read_dotenv(tmp_path / "absent.env") == {}

    def test_a_malformed_line_is_skipped(self, tmp_path: Path) -> None:
        path = write(tmp_path, "GOOD=1\nthis line has no equals sign\nALSO_GOOD=2\n")
        assert read_dotenv(path) == {"GOOD": "1", "ALSO_GOOD": "2"}


class TestMergeEnvironment:
    def test_real_environment_variables_win(self) -> None:
        # An explicit shell export is the stronger signal of intent.
        merged = merge_environment({"KEY": "from-env"}, {"KEY": "from-file"})
        assert merged["KEY"] == "from-env"

    def test_file_values_fill_the_gaps(self) -> None:
        merged = merge_environment({"A": "1"}, {"B": "2"})
        assert merged == {"A": "1", "B": "2"}

    def test_neither_input_is_mutated(self) -> None:
        env = {"A": "1"}
        dotenv = {"B": "2"}
        merge_environment(env, dotenv)
        assert env == {"A": "1"}
        assert dotenv == {"B": "2"}
