#!/usr/bin/env python3
"""Audit CPA auth files and Grok CLI routing without printing credentials."""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


def non_negative_int(value):
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("GROK_MODELS_BASE_URL", "http://127.0.0.1:8317/v1"))
    parser.add_argument("--api-key-env", default="XAI_API_KEY")
    parser.add_argument("--auth-dir", default="~/.cli-proxy-api")
    parser.add_argument(
        "--expected-total-auth-count",
        "--expected-auth-count",
        dest="expected_total_auth_count",
        type=non_negative_int,
        default=None,
        help="Expected total xai-*.json files in the auth directory",
    )
    parser.add_argument("--model", default="grok-4.5")
    parser.add_argument("--live", action="store_true", help="Run one quota-consuming Grok inference check")
    return parser.parse_args(argv)


def fetch_models(base_url, api_key):
    request = urllib.request.Request(
        base_url.rstrip("/") + "/models",
        headers={"Authorization": "Bearer %s" % api_key},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise RuntimeError("CPA /models returned an unexpected payload")
    return [str(item.get("id")) for item in data if isinstance(item, dict) and item.get("id")]


def validate_auth_files(auth_dir):
    files = sorted(Path(auth_dir).expanduser().glob("xai-*.json"))
    invalid = []
    for path in files:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            valid = (
                payload.get("type") == "xai"
                and payload.get("auth_kind") == "oauth"
                and isinstance(payload.get("access_token"), str)
                and bool(payload.get("access_token"))
                and isinstance(payload.get("refresh_token"), str)
                and bool(payload.get("refresh_token"))
            )
            if not valid or (path.stat().st_mode & 0o077):
                invalid.append(path.name)
        except (OSError, ValueError, TypeError):
            invalid.append(path.name)
    return files, invalid


def run_command(argv, env, timeout):
    return subprocess.run(
        argv,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=False,
    )


def main():
    args = parse_args()
    api_key = os.environ.get(args.api_key_env, "").strip() or os.environ.get("CPA_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("missing API key in %s or CPA_API_KEY" % args.api_key_env)

    failures = []
    try:
        models = fetch_models(args.base_url, api_key)
        print("[ok] cpa_models=%d" % len(models))
        if args.model not in models:
            failures.append("requested model is absent from CPA catalog: %s" % args.model)
    except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as exc:
        models = []
        failures.append("CPA model check failed: %s" % exc)

    auth_files, invalid = validate_auth_files(args.auth_dir)
    print("[ok] cpa_auth_files=%d" % len(auth_files))
    if invalid:
        failures.append("invalid or non-private auth files: %d" % len(invalid))
    if args.expected_total_auth_count is not None and len(auth_files) != args.expected_total_auth_count:
        failures.append(
            "expected %d total auth files, found %d"
            % (args.expected_total_auth_count, len(auth_files))
        )

    env = dict(os.environ)
    env["GROK_MODELS_BASE_URL"] = args.base_url.rstrip("/")
    env["GROK_MODELS_LIST_URL"] = args.base_url.rstrip("/") + "/models"
    env["XAI_API_KEY"] = api_key
    try:
        result = run_command(["grok", "models"], env, 30)
        if result.returncode != 0:
            failures.append("grok models failed with exit %d" % result.returncode)
        elif "You are using XAI_API_KEY" not in result.stdout or args.model not in result.stdout:
            failures.append("grok models did not confirm CPA API-key routing and requested model")
        else:
            print("[ok] grok_models_routed=true model=%s" % args.model)
    except (OSError, subprocess.TimeoutExpired) as exc:
        failures.append("grok models failed: %s" % exc)

    if args.live and not failures:
        argv = [
            "grok",
            "-p",
            "Reply with exactly OK.",
            "-m",
            args.model,
            "--output-format",
            "json",
            "--max-turns",
            "2",
            "--verbatim",
            "--no-subagents",
            "--no-memory",
        ]
        try:
            result = run_command(argv, env, 120)
            payload = json.loads(result.stdout)
            used = payload.get("modelUsage", {})
            if result.returncode != 0 or payload.get("stopReason") != "EndTurn" or not payload.get("text"):
                failures.append("live Grok check did not reach EndTurn")
            elif args.model not in used:
                failures.append("live Grok check used an unexpected model")
            else:
                print("[ok] live_grok=true model=%s" % args.model)
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            failures.append("live Grok check failed: %s" % exc)

    if failures:
        for failure in failures:
            print("[fail] %s" % failure, file=sys.stderr)
        raise SystemExit(1)
    print("audit=passed")


if __name__ == "__main__":
    main()
