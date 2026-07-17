#!/usr/bin/env python3
"""Persist Grok CLI routing to a local CPA endpoint without exposing the key."""

import argparse
import json
import os
import re
import shlex
import tempfile
from pathlib import Path


BLOCK_START = "# >>> Grok CLI via local CPA >>>"
BLOCK_END = "# <<< Grok CLI via local CPA <<<"


def atomic_write(path, text, mode=0o600):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".%s." % path.name, suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def upsert_toml_value(text, section, key, value):
    assignment = "%s = %s" % (key, json.dumps(value))
    header = re.compile(r"(?m)^\[" + re.escape(section) + r"\]\s*$")
    match = header.search(text)
    if match is None:
        prefix = text.rstrip()
        return (prefix + "\n\n" if prefix else "") + "[%s]\n%s\n" % (section, assignment)

    body_start = match.end()
    next_header = re.search(r"(?m)^\[[^\n]+\]\s*$", text[body_start:])
    body_end = body_start + next_header.start() if next_header else len(text)
    body = text[body_start:body_end]
    key_pattern = re.compile(r"(?m)^\s*" + re.escape(key) + r"\s*=.*$")
    if key_pattern.search(body):
        body = key_pattern.sub(assignment, body, count=1)
    else:
        body = body.rstrip() + "\n" + assignment + "\n"
    return text[:body_start] + body + text[body_end:]


def managed_env_block(base_url, api_key):
    list_url = base_url.rstrip("/") + "/models"
    return "\n".join(
        [
            BLOCK_START,
            "export GROK_MODELS_BASE_URL=%s" % shlex.quote(base_url),
            "export GROK_MODELS_LIST_URL=%s" % shlex.quote(list_url),
            "export XAI_API_KEY=%s" % shlex.quote(api_key),
            BLOCK_END,
        ]
    )


def upsert_managed_block(text, block):
    pattern = re.compile(
        r"(?ms)^" + re.escape(BLOCK_START) + r"$.*?^" + re.escape(BLOCK_END) + r"$"
    )
    if pattern.search(text):
        return pattern.sub(block, text, count=1).rstrip() + "\n"
    prefix = text.rstrip()
    return (prefix + "\n\n" if prefix else "") + block + "\n"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8317/v1")
    parser.add_argument("--default-model", default="grok-4.5")
    parser.add_argument("--api-key-env", default="CPA_API_KEY")
    parser.add_argument("--grok-config", default="~/.grok/config.toml")
    parser.add_argument("--shell-env", default="~/.zshenv")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise SystemExit("missing API key in environment variable %s" % args.api_key_env)
    if not re.match(r"^https?://", args.base_url):
        raise SystemExit("--base-url must use http or https")

    grok_config = Path(args.grok_config).expanduser()
    shell_env = Path(args.shell_env).expanduser()
    config_text = grok_config.read_text(encoding="utf-8") if grok_config.exists() else ""
    config_text = upsert_toml_value(config_text, "models", "default", args.default_model)
    config_text = upsert_toml_value(config_text, "endpoints", "models_base_url", args.base_url.rstrip("/"))

    shell_text = shell_env.read_text(encoding="utf-8") if shell_env.exists() else ""
    shell_text = upsert_managed_block(shell_text, managed_env_block(args.base_url.rstrip("/"), api_key))

    if args.dry_run:
        print("would update %s" % grok_config)
        print("would update %s" % shell_env)
        print("base_url=%s default_model=%s api_key=present" % (args.base_url.rstrip("/"), args.default_model))
        return

    atomic_write(grok_config, config_text)
    atomic_write(shell_env, shell_text)
    print("updated %s" % grok_config)
    print("updated %s" % shell_env)
    print("base_url=%s default_model=%s api_key=stored" % (args.base_url.rstrip("/"), args.default_model))


if __name__ == "__main__":
    main()
