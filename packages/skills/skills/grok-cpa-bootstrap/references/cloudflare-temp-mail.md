# Cloudflare Temporary Mail

Use this reference only for the Cloudflare-owned part of the workflow. Re-check the current `cloudflare_temp_email` README and Wrangler examples before mutation.

## Inputs

- Cloudflare account and root zone.
- Mail subdomain, such as `mail.example.com`.
- Worker API hostname, such as `temp-mail-api.example.com`.
- Exact intended mail-domain set. Use only the new subdomain for a fresh deployment; preserve old and new subdomains during a migration until existing-account recovery no longer needs the old domain.
- Unique Worker and D1 names.
- Fresh `JWT_SECRET` and administrator password.

Never reuse the CPA downstream key as either Worker secret.

## Install and Authenticate

```bash
cd <cloudflare_temp_email>/worker
pnpm install --frozen-lockfile
pnpm exec wrangler whoami
```

Stop if Wrangler is authenticated to the wrong Cloudflare account. Do not deploy into a similarly named account by assumption. `CLOUDFLARE_API_TOKEN`, or the legacy `CLOUDFLARE_API_KEY` plus `CLOUDFLARE_EMAIL`, takes precedence over stored Wrangler OAuth credentials. Also inspect ignored Wrangler `.env*` files, which can reload those values. When intentionally checking stored OAuth and no project env file defines them, remove those variables for that process only:

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
  pnpm exec wrangler whoami
```

## Create D1

Create one database for the temporary-mail deployment:

```bash
pnpm exec wrangler d1 create <database-name>
```

Record the returned `database_id`. Generate secrets into the current shell without printing them:

```bash
TEMP_MAIL_JWT_SECRET="$(openssl rand -hex 32)"
TEMP_MAIL_ADMIN_PASSWORD="$(openssl rand -hex 24)"
```

Create the repository-ignored `worker/wrangler.toml` with mode `600`. Keep only non-sensitive configuration in `[vars]`; install `JWT_SECRET` and `ADMIN_PASSWORDS` as Worker secrets later. The Worker accepts `ADMIN_PASSWORDS` as a JSON-encoded array string. Adapt binding names to the checked-out repository if its examples changed:

```toml
name = "<worker-name>"
main = "src/worker.ts"
compatibility_date = "<today>"
compatibility_flags = ["nodejs_compat"]
keep_vars = true
workers_dev = false

# On a fresh Worker, add the custom-domain route only after secrets are installed.
# routes = [
#   { pattern = "<worker-api-hostname>", custom_domain = true },
# ]

[vars]
PREFIX = ""
DEFAULT_DOMAINS = ["<mail-subdomain>"]
DOMAINS = ["<mail-subdomain>"]
ENABLE_USER_CREATE_EMAIL = true
DISABLE_ANONYMOUS_USER_CREATE_EMAIL = true
ENABLE_USER_DELETE_EMAIL = true
ENABLE_AUTO_REPLY = false

[[d1_databases]]
binding = "DB"
database_name = "<database-name>"
database_id = "<database-id>"
```

Confirm `wrangler.toml` is ignored before proceeding:

```bash
git check-ignore -v worker/wrangler.toml
chmod 600 worker/wrangler.toml
```

For a migration, append the new subdomain to the existing intended `DEFAULT_DOMAINS` and `DOMAINS` arrays instead of replacing the old domain. Remove an old domain only as a separately authorized decommissioning step.

## Validate and Deploy

Run repository-native checks first:

```bash
pnpm run lint
WRANGLER_LOG=none pnpm run build >/dev/null 2>&1
```

The suppressed dry-run still fails with a non-zero exit status. If it fails, first confirm that no literal secrets remain in `wrangler.toml`, then inspect the error locally without relaying raw resolved configuration. Never paste legacy build or deploy output that contains binding values.

Apply the checked-out schema to remote D1. For a fresh Worker, perform one bootstrap deployment while the custom-domain route is still omitted so the Worker exists without exposing the final hostname:

```bash
pnpm exec wrangler d1 execute <database-name> --remote --file ../db/schema.sql
pnpm run deploy
```

Skip the bootstrap deployment when updating an existing Worker. Install both secrets without putting their values in command arguments or output:

```bash
: "${TEMP_MAIL_JWT_SECRET:?TEMP_MAIL_JWT_SECRET is not set}"
: "${TEMP_MAIL_ADMIN_PASSWORD:?TEMP_MAIL_ADMIN_PASSWORD is not set}"
jq -cn \
  --arg jwt "$TEMP_MAIL_JWT_SECRET" \
  --arg admin "$TEMP_MAIL_ADMIN_PASSWORD" \
  '{JWT_SECRET: $jwt, ADMIN_PASSWORDS: ([$admin] | tojson)}' | \
  pnpm exec wrangler secret bulk
unset TEMP_MAIL_JWT_SECRET
pnpm exec wrangler secret list
```

Require the secret list to contain `JWT_SECRET` and `ADMIN_PASSWORDS`; it must never show their values. Keep `TEMP_MAIL_ADMIN_PASSWORD` only in the current shell until it has been written into the ignored, mode-`600` grok-register config, then unset it. Add the custom-domain route to `wrangler.toml`, then perform the final deployment:

```toml
routes = [
  { pattern = "<worker-api-hostname>", custom_domain = true },
]
```

```bash
pnpm run deploy
```

Record the Worker version ID and custom domain. Do not treat upload success as proof that incoming mail routing works.

## Protect Existing Root Mail

Snapshot public DNS before changing Email Routing:

```bash
dig @1.1.1.1 +short MX <root-domain> | sort
dig @1.1.1.1 +short MX <mail-subdomain> | sort
```

Record the complete root-domain MX result. If it contains an existing mail provider, do not run the apex Email Routing wizard, replace those records, or use an unscoped Email Routing DNS call. The root MX result must compare equal after the subdomain change.

## Configure Email Routing in the Dashboard

In the Cloudflare dashboard:

1. Open **Email Routing** for the root zone without starting or accepting the apex setup wizard.
2. Open **Settings -> Subdomains**.
3. Add only the mail label, for example `mail`, and wait until `mail.example.com` is enabled with DNS records locked.
4. Open **Routing rules**.
5. Filter the domain selector to `mail.example.com`.
6. Edit that subdomain's **Catch-all** rule.
7. Set the action to **Send to a Worker**.
8. Select the new temporary-mail Worker.
9. Save and enable the rule until its state is **Active**.

Do not edit the root-domain catch-all. The edit page can have a root-zone breadcrumb even when the table was filtered; return to the routing table and verify the selected domain, Worker name, and Active state after saving.

## Configure Email Routing Through the API

Use this path when dashboard access cannot safely target the subdomain. Re-check the current Cloudflare Email Routing API schema before mutation. A routing-only Wrangler OAuth session needs `account:read`, `user:read`, `zone:read`, and `email_routing:write`; Worker and D1 deployment require additional scopes. Perform a routing-only login after the final deployment because it replaces the stored OAuth scope set, or use a dedicated API token with zone read and Email Routing Rules write access.

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
  pnpm exec wrangler login \
  --scopes account:read user:read zone:read email_routing:write

CLOUDFLARE_ROUTING_TOKEN="$(
  env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    pnpm exec wrangler auth token --json | jq -er '.token'
)"
read -r 'CLOUDFLARE_ZONE_ID?Cloudflare zone ID: '
```

Never echo the token. Inspect the subdomain-scoped DNS state, enable only that subdomain, and bind only its catch-all:

```bash
curl -fsS --get \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/dns" \
  -H "Authorization: Bearer $CLOUDFLARE_ROUTING_TOKEN" \
  --data-urlencode 'subdomain=<mail-subdomain>' | jq '{success, result}'

curl -fsS -X POST \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/dns" \
  -H "Authorization: Bearer $CLOUDFLARE_ROUTING_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"<mail-subdomain>"}' | jq '{success, result}'

curl -fsS -X PUT \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/rules/catch_all?subdomain=<mail-subdomain>" \
  -H "Authorization: Bearer $CLOUDFLARE_ROUTING_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "actions":[{"type":"worker","value":["<worker-name>"]}],
    "matchers":[{"type":"all"}],
    "enabled":true,
    "name":"Catch-all for <mail-subdomain>"
  }' | jq '{success, result: (.result | {name, enabled, actions, matchers})}'

curl -fsS \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/rules/catch_all?subdomain=<mail-subdomain>" \
  -H "Authorization: Bearer $CLOUDFLARE_ROUTING_TOKEN" | \
  jq '{success, result: (.result | {name, enabled, actions, matchers})}'

unset CLOUDFLARE_ROUTING_TOKEN CLOUDFLARE_ZONE_ID
```

Never omit the `subdomain` query or replace the POST body `name` with the root domain; either mistake can target apex Email Routing. Require every API response to have `success: true`, the catch-all action to name the intended Worker, and `enabled: true`.

## Verify the API Boundary

Verify health and public settings:

```bash
curl -fsS https://<worker-api-hostname>/health_check
curl -fsS https://<worker-api-hostname>/open_api/settings | jq .
```

Expected settings:

- `defaultDomains` and `domains` exactly match the intended set: one new mail subdomain for a fresh deployment, or the explicitly preserved old and new subdomains during migration. They contain no duplicates or unrelated domains.
- `disableAnonymousUserCreateEmail` is `true`.
- `enableUserCreateEmail` is `true` so authenticated admin creation can work.

Prove anonymous mailbox creation is rejected:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  --data '{"name":"anonymous-check","domain":"<mail-subdomain>"}' \
  https://<worker-api-hostname>/api/new_address
```

Expect `403`. Create an administrator mailbox only when needed for an authorized test. Send the administrator password in `x-admin-auth`; never put it in the command history or final answer.

Re-query public DNS after routing is active:

```bash
dig @1.1.1.1 +short MX <root-domain> | sort
dig @1.1.1.1 +short MX <mail-subdomain> | sort
dig @1.1.1.1 +short TXT <mail-subdomain> | sort
```

The root-domain MX set must be identical to the pre-change snapshot. The mail subdomain must expose every record required by the subdomain-scoped Email Routing DNS response, normally Cloudflare MX records plus its verification TXT record.

## Verify Mail Delivery

The first authorized xAI registration is the strongest delivery test because it exercises MX routing, the Worker email handler, D1 storage, mailbox JWT access, and code extraction together.

For read-only D1 evidence:

```bash
pnpm exec wrangler d1 execute <database-name> --remote \
  --command 'SELECT COUNT(*) AS addresses FROM address; SELECT COUNT(*) AS mails FROM raw_mails;' \
  --json
```

Do not query or print raw email bodies unless diagnosing a specific failure. They can contain verification codes and account identifiers.

## Failure Classification

- Worker health fails: custom domain, deployment, or Worker runtime problem.
- Anonymous creation is not `403`: security configuration problem.
- Mailbox creation works but D1 receives no mail: Email Routing or DNS problem.
- D1 receives xAI mail but registration cannot extract a code: message parsing or mailbox API problem.
- xAI rejects the domain before sending mail: domain-reputation problem; changing Worker code will not fix it.
