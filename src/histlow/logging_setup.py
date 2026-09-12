"""Logging with a redaction filter seeded from the secrets loaded at startup.

A safety net against a stray f-string, not a licence to log secrets.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Iterable

MASK = "***REDACTED***"

#: Masking very short values would corrupt unrelated output for no benefit.
_MIN_REDACTABLE_LENGTH = 8


class SecretRedactingFilter(logging.Filter):
    """Replaces known secret values with a fixed mask in every emitted record."""

    def __init__(self, secrets: Iterable[str]) -> None:
        super().__init__()
        # Longest first, so a secret containing another is masked whole.
        self._secrets = sorted(
            {s for s in secrets if s and len(s) >= _MIN_REDACTABLE_LENGTH},
            key=len,
            reverse=True,
        )

    def filter(self, record: logging.LogRecord) -> bool:
        if not self._secrets:
            return True

        message = record.getMessage()
        redacted = message
        for secret in self._secrets:
            redacted = redacted.replace(secret, MASK)

        if redacted != message:
            # Clearing args stops the handler re-expanding the original value.
            record.msg = redacted
            record.args = ()

        if record.exc_text:
            for secret in self._secrets:
                record.exc_text = record.exc_text.replace(secret, MASK)

        return True


def configure_logging(level: str = "INFO", secrets: Iterable[str] = ()) -> None:
    """Installs one redacting handler on stderr, keeping stdout for `--dry-run` output."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    handler.addFilter(SecretRedactingFilter(secrets))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
