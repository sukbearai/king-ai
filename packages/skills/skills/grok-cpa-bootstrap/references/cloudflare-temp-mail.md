# Cloudflare Temporary Mail

Use this reference only for the Cloudflare-owned part of the workflow. Re-check the current `cloudflare_temp_email` README and Wrangler examples before mutation.

## Inputs

- Cloudflare account and root zone.
- Mail subdomain, such as `mail.example.com`.
- Worker API hostname, such as `temp-mail-api.example.com`.
- Unique Worker and D1 names.
- Fresh `JWT_SECRET` and administrator password.

Never reuse the CPA downstream key as either Worker secret.

## Install and Authenticate

```bash
cd <cloudflare_temp_email>/worker
pnpm install --frozen-lockfile
pnpm exec wrangler whoami
```

Stop if Wrangler is authenticated to the wrong Cloudflare account. Do not deploy into a similarly named account by assumption.

## Create D1

Create one database for the temporary-mail deployment:

```bash
pnpm exec wrangler d1 create <database-name>
```

Record the returned `database_id`. Generate secrets locally:

```bash
openssl rand -hex 32  # JWT_SECRET
openssl rand -hex 24  # administrator password
```

Create the repository-ignored `worker/wrangler.toml` with mode `600`. Adapt binding names to the checked-out repository if its examples changed:

```toml
name = "<worker-name>"
main = "src/worker.ts"
compatibility_date = "<today>"
compatibility_flags = ["nodejs_compat"]
keep_vars = true

routes = [
  { pattern = "<worker-api-hostname>", custom_domain = true },
]

[vars]
PREFIX = ""
DEFAULT_DOMAINS = ["<mail-subdomain>"]
DOMAINS = ["<mail-subdomain>"]
JWT_SECRET = "<fresh-secret>"
ADMIN_PASSWORDS = ["<fresh-admin-password>"]
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

## Validate and Deploy

Run repository-native checks first:

```bash
pnpm run lint
pnpm run build
```

Apply the checked-out schema to remote D1, then deploy:

```bash
pnpm exec wrangler d1 execute <database-name> --remote --file ../db/schema.sql
pnpm run deploy
```

Record the Worker version ID and custom domain. Do not treat upload success as proof that incoming mail routing works.

## Configure Email Routing

In the Cloudflare dashboard:

1. Open **Email Routing** for the root zone and verify it is enabled.
2. Open **Settings -> Subdomains**.
3. Add only the mail label, for example `mail`, and wait until `mail.example.com` is enabled with DNS records locked.
4. Open **Routing rules**.
5. Filter the domain selector to `mail.example.com`.
6. Edit that subdomain's **Catch-all** rule.
7. Set the action to **Send to a Worker**.
8. Select the new temporary-mail Worker.
9. Save and enable the rule until its state is **Active**.

Do not edit the root-domain catch-all. The edit page can have a root-zone breadcrumb even when the table was filtered; return to the routing table and verify the selected domain, Worker name, and Active state after saving.

## Verify the API Boundary

Verify health and public settings:

```bash
curl -fsS https://<worker-api-hostname>/health_check
curl -fsS https://<worker-api-hostname>/open_api/settings | jq .
```

Expected settings:

- `defaultDomains` and `domains` contain only the mail subdomain.
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
