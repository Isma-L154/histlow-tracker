"""Logging configured to make secret leakage structurally difficult.

Every handler installed here carries a redaction filter seeded with the exact
secret values loaded at startup. A stray f-string that interpolates a token
therefore prints a mask rather than the token, including inside exception text
and third-party log records.

This is a safety net, not a licence to log secrets. The rule remains: never
write a secret into a log statement.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Iterable

MASK = "***REDACTED***"

#: Values shorter than this are ignored by the filter. Masking a 2-character
#: string would corrupt unrelated output for no security benefit.
_MIN_REDACTABLE_LENGTH = 8


class SecretRedactingFilter(logging.Filter):
    """Replaces known secret values with a fixed mask in every emitted record."""

    def __init__(self, secrets: Iterable[str]) -> None:
        super().__init__()
        # Longest first, so that a secret containing another as a substring is
        # masked as a whole rather than leaving a readable tail behind.
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
            # Collapsing args into the formatted message is required: leaving
            # them in place would let the handler re-expand the original value.
            record.msg = redacted
            record.args = ()

        if record.exc_text:
            for secret in self._secrets:
                record.exc_text = record.exc_text.replace(secret, MASK)

        return True


def configure_logging(level: str = "INFO", secrets: Iterable[str] = ()) -> None:
    """Install a single stderr handler with redaction enabled.

    Output goes to stderr so that stdout stays clean for machine-readable
    payloads, which keeps `--dry-run` pipeable.
    """
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
