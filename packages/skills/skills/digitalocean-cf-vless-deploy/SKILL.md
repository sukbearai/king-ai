---
name: digitalocean-cf-vless-deploy
description: Use when provisioning a fresh DigitalOcean Ubuntu VPS behind Cloudflare to redeploy the same stack used here: Nginx with Let's Encrypt, an existing web app behind a proxied domain, 3x-ui/Xray VLESS over WebSocket/TLS through Cloudflare orange cloud, public 3x-ui panel via Nginx reverse proxy, and working Shadowrocket subscription links.
---

# DigitalOcean Cloudflare VLESS Deploy

Use this skill when the user opens a new DigitalOcean droplet and wants to rebuild the same pattern:

```text
web domain -> Cloudflare orange cloud -> Nginx 443 -> app backend
vpn domain -> Cloudflare orange cloud -> Nginx 443 -> Xray VLESS WebSocket
vpn domain -> Cloudflare orange cloud -> Nginx 443 -> 3x-ui panel and subscription
```

Do not store secrets in the skill or final answer. Ask for the new VPS IP, SSH user/auth method, VPN domain, desired panel credentials, and whether a web app/domain is needed. If the user only wants VPN, do not ask for a website domain.

Local examples may be run from macOS/Linux/Git Bash/WSL. On Windows PowerShell, use `ssh root@<ip>` directly and run package validation with `pnpm --filter @king-ai/skills validate`. Remote deployment commands target Ubuntu on the VPS.

## Required Inputs

- VPS IPv4 address and SSH access.
- Cloudflare zone with an `A` record for the VPN domain.
- Optional web domain only when the user also wants to expose a web app.
- Cloudflare records should normally be orange cloud `Proxied`.
- Cloudflare SSL/TLS mode should be `Full (strict)`.
- Desired web backend port, usually `8080`, only if a web app/domain is requested.
- Desired 3x-ui panel username/password.

## Core Decisions

- Use Cloudflare orange cloud only for HTTP/HTTPS-compatible traffic.
- Do not use Outline for this requirement; Outline's default Shadowsocks TCP/UDP ports do not fit Cloudflare's free orange-cloud proxy.
- Use `VLESS + WebSocket + TLS + 443` for Shadowrocket compatibility through Cloudflare.
- Let Nginx own public `80/443`; keep the 3x-ui panel and Xray inbound behind local/private ports.
- Use Let's Encrypt via Certbot for origin certificates. Cloudflare Origin CA is also valid for Full(strict), but Let's Encrypt keeps direct-origin browser checks trusted.
- `certbot.timer` is the systemd renewal scheduler installed by Certbot. Keep it active so origin certs renew automatically before expiry.
- If the user is in mainland China and direct DigitalOcean IP access is blocked or unstable, the domain must resolve through Cloudflare orange cloud; do not hand out the raw Droplet IP as the client address.

## Deployment Flow

1. Verify the server and existing ports:

```bash
ssh root@<ip>
ss -ltnup
docker ps
ufw status verbose || true
```

2. Install Nginx and Certbot:

```bash
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx jq sqlite3
systemctl enable --now nginx
```

3. Optional: if the user requested a web app/domain, configure the web domain to reverse proxy to the app backend, then issue a cert:

```bash
cat >/etc/nginx/sites-available/site.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name <web-domain> _;

    location / {
        proxy_pass http://127.0.0.1:<web-port>;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/site.conf /etc/nginx/sites-enabled/site.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d <web-domain> --non-interactive --agree-tos --register-unsafely-without-email --redirect
```

If the user only wants VPN, skip this web-domain step entirely.

4. Add the VPN domain certificate:

```bash
certbot --nginx -d <vpn-domain> --non-interactive --agree-tos --register-unsafely-without-email --redirect
```

If Cloudflare returns `526`, the origin cert for the requested hostname is missing or invalid. Re-run the certbot step for that exact hostname and verify Nginx serves it on `443`.

5. Install 3x-ui:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)
```

Recommended install choices:

- SQLite database.
- Fixed panel port such as `54321`.
- Skip panel SSL because Nginx terminates HTTPS.
- Bind panel to `127.0.0.1`.

After install, set the requested credentials explicitly:

```bash
/usr/local/x-ui/x-ui setting -username '<panel-user>' -password '<panel-password>'
systemctl restart x-ui
```

Use quotes around passwords, especially if they contain punctuation such as `.` or `$`.

## VLESS Inbound Pattern

Create one VLESS inbound through the 3x-ui API. Use:

- listen: `127.0.0.1` or empty depending on subscription behavior.
- internal port: `10000` or another free local port.
- protocol: `vless`
- transport: `ws`
- security inside Xray: `none` because TLS terminates at Cloudflare/Nginx.
- WebSocket path: random, for example `/cf-vpn-<hex>`.
- host header: `<vpn-domain>`.

If using the 3x-ui API, first confirm the base path and API token from install output or:

```bash
/usr/local/x-ui/x-ui setting -show true
```

Use `Authorization: Bearer <api-token>` for `/panel/api/inbounds/*` calls when available. If the API token is blank, login with the panel CSRF workflow or use the panel UI.

## Nginx VPN Server Block

Make the VPN host serve only the panel, VLESS WebSocket path, and subscription path:

```nginx
server {
    server_name <vpn-domain>;

    location /<panel-base-path>/ {
        proxy_pass http://127.0.0.1:<panel-port>;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /<ws-path-without-leading-variable> {
        proxy_redirect off;
        proxy_pass http://127.0.0.1:<xray-internal-port>;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /sub/ {
        proxy_pass http://127.0.0.1:2096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        return 404;
    }

    listen [::]:443 ssl;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/<vpn-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<vpn-domain>/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    listen [::]:80;
    server_name <vpn-domain>;
    return 301 https://$host$request_uri;
}
```

Run:

```bash
nginx -t && systemctl reload nginx
systemctl restart x-ui
```

## Subscription Fix

3x-ui may initially generate subscription links like `localhost:<internal-port>` or `127.0.0.1:<internal-port>`. That is not usable from Shadowrocket.

Fix it by setting an inbound external proxy/front in 3x-ui:

- `forceTls`: `tls`
- `dest`: `<vpn-domain>`
- `port`: `443`
- `sni`: `<vpn-domain>`
- `fingerprint`: `chrome`
- `alpn`: `http/1.1`

After that, the subscription should decode to a VLESS link like:

```text
vless://<uuid>@<vpn-domain>:443?...&security=tls&sni=<vpn-domain>&type=ws
```

Subscription URL pattern:

```text
https://<vpn-domain>/sub/<subId>
```

For Shadowrocket, prefer importing the subscription URL or the decoded `vless://...` node. Do not use `http://<vpn-domain>:2096/sub/<subId>` when the goal is Cloudflare 443 access.

## Mainland China Latency

If the node works but feels slow from mainland China, first verify the client is really using `<vpn-domain>:443` through Cloudflare, not the raw Droplet IP or an internal port.

For a simple free setup, keep the Cloudflare record as orange cloud and try a different Cloudflare-routed hostname or CNAME provider only if the current route is consistently slow. The practical options are:

- Use the normal orange-cloud `A` record first. This is the most maintainable default.
- If the user has a tested Cloudflare preferred IP hostname from a provider, create a `CNAME` for the VPN hostname to that provider hostname and keep it proxied if Cloudflare allows it for the zone.
- If using a preferred IP locally in Shadowrocket, keep `sni` and `host` as `<vpn-domain>`; only the dial address changes. Do not change the certificate hostname to the preferred IP.

Do not treat preferred IP/CNAME as the first deployment step. It is a routing optimization after the functional 443 WebSocket node is verified.

## Verification

Run these checks before handoff:

```bash
systemctl is-active nginx x-ui docker certbot.timer
ss -ltnp | egrep ':(80|443|10000|54321|2096)\b' || true
curl -I https://<web-domain>/
curl -I https://<vpn-domain>/
curl -sS https://<vpn-domain>/sub/<subId> | base64 -d
```

Expected:

- Web domain returns `200` through Cloudflare when configured.
- VPN root may return `404`; that is fine.
- VPN WebSocket path should reach Xray. A synthetic incomplete WebSocket request may return `400 Bad Request`, which is acceptable evidence that Nginx reached Xray.
- Subscription decodes to `<vpn-domain>:443`, not `localhost:<internal-port>`.
- Shadowrocket import works and client traffic appears in 3x-ui after use.

## Common Failures

- `521 Web server is down`: Cloudflare cannot connect to origin `80/443`. Check Nginx listeners, firewall, and origin IP.
- `526 Invalid SSL certificate`: Cloudflare Full(strict) rejected origin cert. Issue a cert for the exact hostname.
- Cert expiry risk: confirm `systemctl is-active certbot.timer` and test with `certbot renew --dry-run`. If it fails, fix renewal before handoff.
- Website works but VLESS does not: confirm Cloudflare record is orange cloud, client uses `type=ws`, `security=tls`, `sni=<vpn-domain>`, `host=<vpn-domain>`, and the exact WebSocket path.
- Subscription imports an unusable node: decode it and check for `localhost`, `127.0.0.1`, internal ports, or `security=none`. Add/fix the inbound external proxy.
- Panel login fails after password change: test locally with the CSRF login flow and verify whether punctuation was included. Always quote password arguments.

## Handoff Template

Report:

- Domains and Cloudflare proxy state used.
- Nginx public ports and local upstream ports.
- 3x-ui panel URL only if the user needs it; do not include password unless explicitly requested.
- VLESS WebSocket path and subscription URL.
- Verification command results.
- Any remaining risk, especially Cloudflare regional latency or domain DNS propagation.
