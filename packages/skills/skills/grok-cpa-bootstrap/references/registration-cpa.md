# Registration and CPA Recovery

Use this reference after the Cloudflare Worker API and subdomain catch-all have passed their independent checks.

## Configure grok-register

Create an ignored `config.json` under the `grok-register` checkout. Preserve repository defaults not shown here and use the current `config.example.json` as the schema authority.

```json
{
  "email_provider": "cloudflare",
  "cloudflare_api_base": "https://<worker-api-hostname>",
  "cloudflare_api_key": "<temporary-mail-admin-password>",
  "cloudflare_auth_mode": "x-admin-auth",
  "cloudflare_path_domains": "/api/domains",
  "cloudflare_path_accounts": "/admin/new_address",
  "cloudflare_path_token": "/api/token",
  "cloudflare_path_messages": "/api/mails",
  "defaultDomains": "<mail-subdomain>",
  "register_count": 1,
  "enable_nsfw": true,
  "proxy": "",
  "cpa_export_enabled": true,
  "cpa_auth_dir": "~/.cli-proxy-api",
  "cpa_copy_to_hotload": false,
  "cpa_hotload_dir": "",
  "cpa_base_url": "https://cli-chat-proxy.grok.com/v1",
  "cpa_proxy": "",
  "cpa_headless": false,
  "cpa_force_standalone": true,
  "cpa_mint_timeout_sec": 300,
  "cpa_mint_cookie_inject": true,
  "cpa_oidc_request_timeout_sec": 15,
  "cpa_oidc_poll_timeout_sec": 15
}
```

Set `register_count` only after the user explicitly authorizes a real count. Secure and validate the config:

```bash
git check-ignore -v config.json
chmod 600 config.json
.venv/bin/python -c 'import app_config; app_config.validate_run_requirements(app_config.load_config()); print("config=ok")'
.venv/bin/python -m unittest discover -s tests -v
```

## Run an Authorized Batch

Start unbuffered so progress is observable:

```bash
printf 'start\n' | PYTHONUNBUFFERED=1 .venv/bin/python grok_register_ttk.py cli
```

Monitor distinct checkpoints per account:

1. Administrator mailbox created.
2. xAI accepted the email domain.
3. Verification mail stored and code extracted.
4. Profile submitted and SSO cookie obtained.
5. Optional NSFW update completed.
6. CPA OIDC auth JSON written.
7. Account result appended.

Do not count a mailbox as a registered account. Use the process summary and the account output line count.

## Protect Results

Account output and mailbox credential files contain live secrets:

```bash
chmod 600 accounts_*.txt mail_credentials.txt
find ~/.cli-proxy-api -maxdepth 1 -name 'xai-*.json' -exec chmod 600 {} +
```

Never commit these files. Confirm the source worktree has no unintended tracked changes.

## Recover OIDC Export Failures

`429 slow_down` can occur at device-code creation even after registration succeeded. Do not rerun registration for those accounts.

Use the bundled recovery script:

```bash
<grok-register>/.venv/bin/python <skill-dir>/scripts/retry_cpa_auth.py \
  --repo <grok-register> \
  --accounts <account-output> \
  --expected-count <expected-count> \
  --attempts 3 \
  --between-accounts 45 \
  --retry-cooldown 75
```

The account output format is `email----password----sso`. The tool must never echo the password or SSO value. It skips an account when the matching `xai-<email>.json` already exists.

Historical `cpa_auth_failed.txt` entries are audit records. A recovered entry can remain in that file; determine current success from the auth JSON set, not from the absence of historical errors.

## Verify CPA Import

Check only safe fields and counts:

```bash
find ~/.cli-proxy-api -maxdepth 1 -name 'xai-*.json' | wc -l

for file in ~/.cli-proxy-api/xai-*.json; do
  jq -e '(.type == "xai") and (.auth_kind == "oauth") and
    (.access_token | type == "string" and length > 0) and
    (.refresh_token | type == "string" and length > 0)' "$file" >/dev/null
done
```

Restart CPA after a bulk recovery to clear in-memory cooldown state:

```bash
brew services restart cliproxyapi
```

## Configure and Verify Grok CLI

The CPA service, auth directory, and Grok CLI are separate. Installing CPA does not route Grok automatically.

The required Grok environment is:

```bash
export GROK_MODELS_BASE_URL='http://127.0.0.1:8317/v1'
export GROK_MODELS_LIST_URL='http://127.0.0.1:8317/v1/models'
export XAI_API_KEY='<CPA downstream API key>'
```

Use `configure_grok_cpa.py` to persist these values safely. Restart existing daemons or terminals after changing `~/.zshenv`.

Verify catalog routing:

```bash
zsh -lc 'grok models'
```

For an explicitly authorized live check:

```bash
zsh -lc 'grok -p "Reply with exactly OK." --output-format json \
  --max-turns 2 --verbatim --no-subagents --no-memory'
```

Require `stopReason: EndTurn`, a non-empty response, and `modelUsage` for the selected model.

## Interpret Entitlement Errors

- `/v1/models` succeeds but inference says `auth_unavailable`: credentials may be cooled down or not loaded; inspect CPA error logs and restart once after fixing the cause.
- CPA logs show every `auth_id` and end with `personal-team-blocked:spending-limit`: import succeeded, but that exact model lacks upstream credits or subscription entitlement.
- One model is blocked while another succeeds: keep the successful model as default and report the blocked model separately.
- Never describe registration or OAuth import as a way to bypass upstream billing or entitlement.
