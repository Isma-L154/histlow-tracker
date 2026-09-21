"""Byte-level checks on the files the repository tracks.

A BOM and a stray control character are invisible in a terminal, in a diff and
in a review, which is exactly why neither was caught by reading. `README.md`
carried a literal BEL where `Scripts\\activate` had lost its backslash, and two
workflows opened with a BOM, for as long as anyone had been looking at them.

The tracker already decodes every file it reads as `utf-8-sig` because Windows
editors add a BOM. These assertions are the other half: the repository's own
files should not need that courtesy in the first place.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent

UTF8_BOM = b"\xef\xbb\xbf"

#: Tab, newline and carriage return are the whitespace a text file may hold.
ALLOWED_CONTROL_BYTES = {0x09, 0x0A, 0x0D}

#: DEL sits above the C0 block but is as invisible, and as unintended, as any of it.
DELETE_BYTE = 0x7F

#: The extensions `.gitattributes` declares binary, and the only ones skipped.
#:
#: Stated as what to exclude rather than what to include. An allowlist of text
#: extensions silently drops whatever it forgets - `_headers`, `.gitignore` and
#: `LICENSE` have no suffix at all - and the files it forgets are exactly the
#: ones nobody opens. Excluding instead means a new file type is covered by
#: default, and a genuinely binary one announces itself as a failure here.
BINARY_SUFFIXES = frozenset({".png", ".jpg", ".ico"})


def _tracked_text_files() -> list[Path]:
    """The text files git tracks, so an ignored artefact is never asserted on."""
    # S607: git is resolved through PATH because an absolute path would differ
    # on every platform this suite runs on. The argument list is fixed.
    listing = subprocess.run(
        ["git", "ls-files", "-z"],  # noqa: S607
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        check=True,
        text=True,
        # Without this, git's bytes are decoded with the locale encoding, which
        # is cp1252 on a Windows checkout. The first non-ASCII path would then
        # mangle into a file that cannot be opened.
        encoding="utf-8",
    )
    return sorted(
        REPOSITORY_ROOT / name
        for name in listing.stdout.split("\0")
        if name and Path(name).suffix.lower() not in BINARY_SUFFIXES
    )


TRACKED_TEXT_FILES = _tracked_text_files()


def _identify(path: Path) -> str:
    """The path from the repository root: two tracked files are named `env.d.ts`."""
    return path.relative_to(REPOSITORY_ROOT).as_posix()


def test_the_listing_is_not_empty() -> None:
    """Guards the guard: a broken `git ls-files` would pass every check below silently."""
    assert TRACKED_TEXT_FILES, "no tracked text files were found; the scan proves nothing"


@pytest.mark.parametrize("path", TRACKED_TEXT_FILES, ids=_identify)
def test_no_tracked_text_file_starts_with_a_byte_order_mark(path: Path) -> None:
    relative = path.relative_to(REPOSITORY_ROOT)
    assert not path.read_bytes().startswith(UTF8_BOM), (
        f"{relative} starts with a UTF-8 BOM. Save it as UTF-8 without one; "
        "a BOM is invisible in review and rides along into whatever reads the file."
    )


@pytest.mark.parametrize("path", TRACKED_TEXT_FILES, ids=_identify)
def test_no_tracked_text_file_holds_a_control_character(path: Path) -> None:
    """Catches an escape that was interpreted rather than written, such as `\\a` as BEL."""
    relative = path.relative_to(REPOSITORY_ROOT)
    offenders = [
        (index, byte)
        for index, byte in enumerate(path.read_bytes())
        if (byte < 0x20 or byte == DELETE_BYTE) and byte not in ALLOWED_CONTROL_BYTES
    ]
    assert not offenders, (
        f"{relative} holds {len(offenders)} control character(s), first at byte "
        f"{offenders[0][0]} (0x{offenders[0][1]:02x}). A backslash escape was most "
        "likely interpreted instead of written literally."
    )
