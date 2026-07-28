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

Use `proxy` for the main registration browser and `cpa_proxy` for the complete CPA OIDC flow. When either flow must use a proxy, set it explicitly instead of relying on a terminal or desktop application's implicit proxy state. The CPA device-code request, authorization browser, and token poll must share the same resolved `cpa_proxy`.

For a one-off recovery, prefer the `CPA_OIDC_PROXY` environment override accepted by `retry_cpa_auth.py`; it keeps proxy credentials out of command arguments and overrides `cpa_proxy` only in memory. The recovery output reports only whether the source is configured, never the proxy URL. Confirm a local proxy listener and OIDC discovery through that route before starting. Proxy consistency is a prerequisite, not evidence that an xAI rejection will be removed.

```bash
lsof -nP -iTCP:<local-proxy-port> -sTCP:LISTEN
HTTPS_PROXY="$CPA_OIDC_PROXY" curl -fsS -o /dev/null \
  -w 'oidc_discovery_http=%{http_code}\n' \
  https://auth.x.ai/.well-known/openid-configuration
```

Require `oidc_discovery_http=200`. These commands reference the environment variable literally, so authenticated proxy credentials do not enter shell history.

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
  --expected-account-count <batch-account-count> \
  --attempts 3 \
  --between-accounts 45 \
  --retry-cooldown 75
```

The account output format is `email----password----sso`. The tool must never echo the email, password, SSO value, OAuth user code, proxy URL, or auth path. It reports only account indexes, counts, sanitized progress events, and controlled error categories. It skips an account when the matching `xai-<email>.json` already exists.

Retry only `rate_limited`, `network`, and `upstream_server` categories. Stop the recovery run for `access_denied`, `identity_mismatch`, `risk_control`, `credentials`, `cancelled`, `unknown`, or exhausted transient retries. Preserve registered accounts and auth evidence instead of rerunning registration or cycling routes.

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

Keep the count scopes separate:

- `--expected-account-count` validates records in the current account result file.
- `batch_auth_files` in the recovery summary counts auth files belonging to that result file.
- `--expected-total-auth-count` validates every `xai-*.json` in the CPA auth directory. Compute it from the pre-batch total plus the batch auth count required for acceptance, normally the registered account count. Do not lower it to the actual successful count after a failure.

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

## Interpret OIDC and Entitlement Errors

- The browser shows `Device Authorized`, but no auth JSON is written and the token endpoint returns `invalid_grant: Access denied`: consent UI completed, but xAI rejected the device grant. Stop the recovery run and report the exact error category. Do not assert that the cause is IP reputation, account age, email domain, plan, or Build eligibility without independent evidence.
- An explicit proxy produces the same `invalid_grant: Access denied`: proxy routing has been controlled, but the denial remains an upstream decision. Do not rotate IPs or repeat device grants to bypass it.
- `429 slow_down`, transport timeouts, or upstream `5xx`: keep the registered account and retry sequentially with cooldown.
- `/v1/models` succeeds but inference says `auth_unavailable`: credentials may be cooled down or not loaded; inspect CPA error logs and restart once after fixing the cause.
- CPA logs show every `auth_id` and end with `personal-team-blocked:spending-limit`: import succeeded, but that exact model lacks upstream credits or subscription entitlement.
- One model is blocked while another succeeds: keep the successful model as default and report the blocked model separately.
- Never describe registration or OAuth import as a way to bypass upstream billing or entitlement.
