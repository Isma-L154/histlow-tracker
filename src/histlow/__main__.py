"""Command-line entry point.

Exit codes are distinct on purpose, because the responses differ:

    0  the run completed, or the schedule gate decided there was no work
    1  the configuration is wrong - a human has to fix something
    2  an upstream dependency failed - likely transient, worth watching

Anything other than 0 fails the workflow, which is deliberate. A tracker that
quietly stops working is worse than one that visibly breaks: GitHub emails on a
failed scheduled run, and that notification is the only thing standing between
a broken pipeline and months of unexplained silence.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from .config import ConfigError, load_settings
from .dotenv import merge_environment, read_dotenv
from .itad import ItadError
from .logging_setup import configure_logging
from .net import HttpError
from .pipeline import Paths, run
from .publisher import PublishError
from .steam import SteamError

log = logging.getLogger("histlow")

EXIT_OK = 0
EXIT_CONFIG_ERROR = 1
EXIT_UPSTREAM_ERROR = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="histlow",
        description="Alert when a wishlisted Steam game hits its all-time low price.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config.json"),
        help="path to the non-secret configuration file (default: config.json)",
    )
    parser.add_argument(
        "--var-dir",
        type=Path,
        default=Path("var"),
        help="directory holding state and the identity cache (default: var)",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(".env"),
        help="optional local credentials file, ignored when absent (default: .env)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run everything but print the payload instead of publishing it",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="bypass the schedule gate and run now",
    )
    parser.add_argument(
        "--log-level",
        default=None,
        help="override LOG_LEVEL (DEBUG, INFO, WARNING, ERROR)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    environment = merge_environment(dict(os.environ), read_dotenv(args.env_file))
    if args.dry_run:
        environment["DRY_RUN"] = "true"
    if args.log_level:
        environment["LOG_LEVEL"] = args.log_level

    # Logging is configured before anything else can fail, and is seeded with
    # the loaded secrets so that even a failure message cannot leak one.
    try:
        settings = load_settings(environment, args.config)
    except ConfigError as exc:
        configure_logging("INFO")
        log.error("%s", exc)
        return EXIT_CONFIG_ERROR

    configure_logging(settings.log_level, settings.secrets.redactable_values())

    try:
        result = run(
            settings,
            paths=Paths.under(args.var_dir),
            now=datetime.now(tz=UTC),
            forced=args.force,
        )
    except ConfigError as exc:
        log.error("%s", exc)
        return EXIT_CONFIG_ERROR
    except (SteamError, ItadError, PublishError, HttpError) as exc:
        # Upstream failure. The state file was not advanced, so the next run
        # retries from a clean position rather than assuming success.
        log.error("run failed: %s", exc)
        return EXIT_UPSTREAM_ERROR

    log.info("%s", result.describe())
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
