#!/usr/bin/env python3
"""Retry missing grok-register CPA OIDC exports sequentially with cooldowns."""

import argparse
import os
import sys
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Path to the grok-register checkout")
    parser.add_argument("--accounts", required=True, help="Saved accounts_*.txt file")
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--between-accounts", type=int, default=45)
    parser.add_argument("--retry-cooldown", type=int, default=75)
    return parser.parse_args()


def load_accounts(path):
    accounts = []
    for number, raw in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        parts = raw.split("----", 2)
        if len(parts) != 3 or not parts[0].strip():
            raise ValueError("invalid account record at line %d" % number)
        accounts.append((parts[0].strip(), parts[1], parts[2]))
    return accounts


def main():
    args = parse_args()
    repo = Path(args.repo).expanduser().resolve()
    accounts_path = Path(args.accounts).expanduser().resolve()
    if not (repo / "app_config.py").is_file() or not (repo / "cpa_export.py").is_file():
        raise SystemExit("--repo is not a compatible grok-register checkout")
    if args.attempts < 1 or args.between_accounts < 0 or args.retry_cooldown < 0:
        raise SystemExit("retry and cooldown values must be non-negative")

    sys.path.insert(0, str(repo))
    from app_config import load_config  # pylint: disable=import-error,import-outside-toplevel
    from cpa_export import export_cpa_xai_for_account  # pylint: disable=import-error,import-outside-toplevel
    from cpa_xai.browser_session import shutdown_mint_browsers  # pylint: disable=import-error,import-outside-toplevel

    config = load_config()
    auth_dir = Path(config["cpa_auth_dir"]).expanduser().resolve()
    accounts = load_accounts(accounts_path)
    if args.expected_count and len(accounts) != args.expected_count:
        raise SystemExit("expected %d account records, found %d" % (args.expected_count, len(accounts)))

    missing = [
        item for item in accounts if not (auth_dir / ("xai-%s.json" % item[0])).is_file()
    ]
    print("[retry] accounts=%d missing=%d" % (len(accounts), len(missing)), flush=True)
    exhausted = []
    try:
        for index, (email, password, sso) in enumerate(missing, 1):
            target = auth_dir / ("xai-%s.json" % email)
            for attempt in range(1, args.attempts + 1):
                print(
                    "[retry] account=%d/%d email=%s attempt=%d"
                    % (index, len(missing), email, attempt),
                    flush=True,
                )
                result = export_cpa_xai_for_account(
                    email=email,
                    password=password,
                    sso=sso,
                    config=config,
                    log_callback=lambda message: print(message, flush=True),
                )
                if result.get("ok") and target.is_file():
                    os.chmod(str(target), 0o600)
                    print("[retry] success email=%s" % email, flush=True)
                    break
                print("[retry] failed email=%s error=%s" % (email, result.get("error") or "unknown"), flush=True)
                if attempt < args.attempts:
                    print("[retry] cooldown=%ds" % args.retry_cooldown, flush=True)
                    time.sleep(args.retry_cooldown)
            else:
                exhausted.append(email)
            if index < len(missing):
                print("[retry] next_account_cooldown=%ds" % args.between_accounts, flush=True)
                time.sleep(args.between_accounts)
    finally:
        shutdown_mint_browsers()

    remaining = [
        email for email, _, _ in accounts if not (auth_dir / ("xai-%s.json" % email)).is_file()
    ]
    print("[retry] complete auth_files=%d remaining=%d" % (len(accounts) - len(remaining), len(remaining)), flush=True)
    if remaining or exhausted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
