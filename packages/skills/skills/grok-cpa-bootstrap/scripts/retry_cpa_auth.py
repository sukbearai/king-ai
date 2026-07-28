#!/usr/bin/env python3
"""Retry missing grok-register CPA OIDC exports sequentially with cooldowns."""

import argparse
import os
import sys
import time
from pathlib import Path


ERROR_MARKERS = (
    ("access_denied", ("invalid_grant", "access_denied", "access denied")),
    ("identity_mismatch", ("consent identity mismatch", "identity mismatch")),
    ("risk_control", ("turnstile", "cloudflare", "risk control", "risk-control", "blocked")),
    ("credentials", ("invalid credentials", "incorrect password", "password rejected")),
    ("cancelled", ("cancelled", "canceled")),
    ("rate_limited", ("slow_down", "too many requests", "http 429", " 429")),
    (
        "network",
        (
            "timed out",
            "timeout",
            "temporary failure",
            "temporarily unavailable",
            "connection reset",
            "connection refused",
            "remote end closed",
            "broken pipe",
            "network",
            "ssl",
        ),
    ),
    (
        "upstream_server",
        (
            "http 500",
            "http 502",
            "http 503",
            "http 504",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
        ),
    ),
)
RETRYABLE_CATEGORIES = frozenset(("rate_limited", "network", "upstream_server"))


def non_negative_int(value):
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Path to the grok-register checkout")
    parser.add_argument("--accounts", required=True, help="Saved accounts_*.txt file")
    parser.add_argument(
        "--expected-account-count",
        "--expected-count",
        dest="expected_account_count",
        type=non_negative_int,
        default=None,
        help="Expected records in this account result file",
    )
    parser.add_argument("--attempts", type=non_negative_int, default=3)
    parser.add_argument("--between-accounts", type=non_negative_int, default=45)
    parser.add_argument("--retry-cooldown", type=non_negative_int, default=75)
    parser.add_argument(
        "--proxy-env",
        default="CPA_OIDC_PROXY",
        help="Environment variable containing an in-memory CPA OIDC proxy override",
    )
    return parser.parse_args(argv)


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


def classify_auth_error(error):
    text = str(error or "").strip().lower()
    for category, markers in ERROR_MARKERS:
        if any(marker in text for marker in markers):
            return category, category in RETRYABLE_CATEGORIES
    return "unknown", False


def safe_progress_event(message):
    text = str(message or "").lower()
    if "device user_code=" in text:
        return "device_code_created"
    if "browser proxy=" in text:
        return "browser_proxy_none" if "proxy=(none)" in text else "browser_proxy_configured"
    if "oauth poll: authorization_pending" in text:
        return "authorization_pending"
    if "oauth poll: slow_down" in text:
        return "rate_limited"
    if "token poll success" in text:
        return "token_received"
    if "wrote " in text:
        return "auth_written"
    return None


def proxy_source(config, environ, proxy_env):
    if str(environ.get(proxy_env) or "").strip():
        return "explicit_env"
    if str(config.get("cpa_proxy") or "").strip():
        return "cpa_config"
    if str(config.get("proxy") or "").strip():
        return "registration_config"
    proxy_names = ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY")
    if any(str(environ.get(name) or "").strip() for name in proxy_names):
        return "process_env"
    return "none"


def apply_proxy_override(config, environ, proxy_env):
    value = str(environ.get(proxy_env) or "").strip()
    if not value:
        return config
    updated = dict(config)
    updated["cpa_proxy"] = value
    return updated


def safe_logger():
    emitted = set()

    def log(message):
        event = safe_progress_event(message)
        if event and event not in emitted:
            emitted.add(event)
            print("[retry] oidc_event=%s" % event, flush=True)

    return log


def recover_account(
    export_account,
    email,
    password,
    sso,
    config,
    target,
    index,
    total,
    attempts,
    retry_cooldown,
    sleep=time.sleep,
):
    final_category = "unknown"
    for attempt in range(1, attempts + 1):
        print(
            "[retry] account=%d/%d attempt=%d" % (index, total, attempt),
            flush=True,
        )
        result = export_account(
            email=email,
            password=password,
            sso=sso,
            config=config,
            log_callback=safe_logger(),
        )
        if result.get("ok") and target.is_file():
            os.chmod(str(target), 0o600)
            print("[retry] success account=%d/%d" % (index, total), flush=True)
            return None

        final_category, retryable = classify_auth_error(result.get("error"))
        print(
            "[retry] failed account=%d/%d category=%s retryable=%s"
            % (index, total, final_category, str(retryable).lower()),
            flush=True,
        )
        if not retryable:
            print("[retry] automated_recovery_stopped=true", flush=True)
            return final_category
        if attempt < attempts:
            print("[retry] cooldown=%ds" % retry_cooldown, flush=True)
            sleep(retry_cooldown)
    return final_category


def main():
    args = parse_args()
    repo = Path(args.repo).expanduser().resolve()
    accounts_path = Path(args.accounts).expanduser().resolve()
    if not (repo / "app_config.py").is_file() or not (repo / "cpa_export.py").is_file():
        raise SystemExit("--repo is not a compatible grok-register checkout")
    if args.attempts < 1:
        raise SystemExit("--attempts must be at least 1")

    sys.path.insert(0, str(repo))
    from app_config import load_config  # pylint: disable=import-error,import-outside-toplevel
    from cpa_export import export_cpa_xai_for_account  # pylint: disable=import-error,import-outside-toplevel
    from cpa_xai.browser_session import shutdown_mint_browsers  # pylint: disable=import-error,import-outside-toplevel

    config = load_config()
    oidc_proxy_source = proxy_source(config, os.environ, args.proxy_env)
    config = apply_proxy_override(config, os.environ, args.proxy_env)
    auth_dir = Path(config["cpa_auth_dir"]).expanduser().resolve()
    accounts = load_accounts(accounts_path)
    if args.expected_account_count is not None and len(accounts) != args.expected_account_count:
        raise SystemExit(
            "expected %d account records, found %d"
            % (args.expected_account_count, len(accounts))
        )

    missing = [
        item for item in accounts if not (auth_dir / ("xai-%s.json" % item[0])).is_file()
    ]
    print(
        "[retry] accounts=%d missing=%d oidc_proxy_source=%s"
        % (len(accounts), len(missing), oidc_proxy_source),
        flush=True,
    )
    failure_category = None
    try:
        for index, (email, password, sso) in enumerate(missing, 1):
            target = auth_dir / ("xai-%s.json" % email)
            category = recover_account(
                export_cpa_xai_for_account,
                email,
                password,
                sso,
                config,
                target,
                index,
                len(missing),
                args.attempts,
                args.retry_cooldown,
            )
            if category:
                failure_category = category
                break
            if index < len(missing):
                print("[retry] next_account_cooldown=%ds" % args.between_accounts, flush=True)
                time.sleep(args.between_accounts)
    finally:
        shutdown_mint_browsers()

    remaining_count = sum(
        1 for email, _, _ in accounts if not (auth_dir / ("xai-%s.json" % email)).is_file()
    )
    category_summary = "%s:1" % failure_category if failure_category else "none"
    print(
        "[retry] complete auth_files=%d batch_auth_files=%d remaining=%d failure_categories=%s"
        % (
            len(accounts) - remaining_count,
            len(accounts) - remaining_count,
            remaining_count,
            category_summary,
        ),
        flush=True,
    )
    if remaining_count:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
