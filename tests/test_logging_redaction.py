"""Tests for the log redaction safety net.

These assert the guarantee that matters most in CI: a secret interpolated into
a log statement by mistake never reaches the runner's output.
"""

from __future__ import annotations

import logging

from histlow.logging_setup import MASK, SecretRedactingFilter


def _record(message: str, *args: object) -> logging.LogRecord:
    return logging.LogRecord(
        name="test", level=logging.INFO, pathname=__file__, lineno=1,
        msg=message, args=args, exc_info=None,
    )


class TestSecretRedactingFilter:
    def test_masks_a_secret_embedded_in_the_message(self) -> None:
        record = _record("calling api with key=super-secret-token-value")
        SecretRedactingFilter(["super-secret-token-value"]).filter(record)
        assert "super-secret-token-value" not in record.getMessage()
        assert MASK in record.getMessage()

    def test_masks_a_secret_passed_as_a_lazy_format_argument(self) -> None:
        # The dangerous case: the value only materialises at format time, so
        # inspecting `record.msg` alone would miss it.
        record = _record("token is %s", "super-secret-token-value")
        SecretRedactingFilter(["super-secret-token-value"]).filter(record)
        assert "super-secret-token-value" not in record.getMessage()

    def test_masks_a_secret_inside_rendered_exception_text(self) -> None:
        record = _record("request failed")
        record.exc_text = "PermanentHttpError: bad key super-secret-token-value"
        SecretRedactingFilter(["super-secret-token-value"]).filter(record)
        assert "super-secret-token-value" not in record.exc_text

    def test_overlapping_secrets_are_fully_masked(self) -> None:
        # Ordering matters: masking the short value first would leave the tail
        # of the longer one readable.
        record = _record("value=abcdefgh-ijklmnop")
        SecretRedactingFilter(["abcdefgh", "abcdefgh-ijklmnop"]).filter(record)
        assert "ijklmnop" not in record.getMessage()

    def test_ignores_values_too_short_to_be_credentials(self) -> None:
        record = _record("processing app 730 in region ES")
        SecretRedactingFilter(["ES", "730"]).filter(record)
        assert record.getMessage() == "processing app 730 in region ES"

    def test_leaves_clean_records_untouched(self) -> None:
        record = _record("found %d discounted titles", 4)
        assert SecretRedactingFilter(["super-secret-token-value"]).filter(record) is True
        assert record.getMessage() == "found 4 discounted titles"

    def test_empty_secret_set_is_a_no_op(self) -> None:
        record = _record("nothing to hide")
        assert SecretRedactingFilter([]).filter(record) is True
        assert record.getMessage() == "nothing to hide"
