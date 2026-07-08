---
name: bytevirt-hysteria2-node
description: "Use when provisioning or auditing a ByteVirt VPS as a no-panel Hysteria2 proxy node: SSH into a fresh Debian 12 server, install the official Hysteria2 systemd service, generate password auth and salamander obfuscation credentials, configure self-signed TLS or a domain certificate, verify UDP reachability, and produce Shadowrocket hy2:// import links."
---

# ByteVirt Hysteria2 Node

Use this skill when the user buys a ByteVirt VPS and wants a direct Hysteria2 node like:

```text
client -> <bytevirt-ip>:443/udp -> Hysteria2 -> freedom outbound
```

Prefer a no-panel Hysteria2 deployment unless the user explicitly asks for a management panel. Do not install x-ui/3x-ui for this requirement. Do not store provider passwords, auth passwords, obfuscation passwords, private keys, or complete live node links in the skill.

## Required Inputs

- ByteVirt public IPv4 address.
- SSH port.
- SSH user and auth method.
- Desired Hysteria2 UDP port, normally `443`.
- Desired label, for example `bytevirt-hy2-jp-443`.
- Optional domain name. If no domain is available, use a self-signed certificate and require client `insecure: true`.
- Debian 12 is the preferred OS. If the provider asks for an OS, choose Debian 12.

If the user has just created the VPS and SSH times out during banner exchange, retry with `PubkeyAuthentication=no` and password-only auth before assuming the server is broken. ByteVirt may expose the TCP port before `sshd` is fully ready.

## Safety Defaults

- Install official Hysteria2 with `https://get.hy2.sh/`.
- Use `hysteria-server.service` and enable it at boot.
- Use password auth plus `salamander` obfuscation by default.
- Generate a fresh auth password and obfuscation password for every node.
- Keep `/etc/hysteria/config.yaml` and `/etc/hysteria/server.key` restricted.
- Do not print generated secrets in final answers unless the user asks for an import artifact.
- Use UDP `443` unless it is already required by another UDP service or the provider blocks it.
- If local Linux firewalls are active, open the selected UDP port. Do not install or enable a new firewall just for this task.

## Preflight

Run from the local machine:

```bash
SSHPASS='<password>' sshpass -e ssh -4 \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password \
  -o NumberOfPasswordPrompts=1 \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  -p <ssh-port> root@<ip> \
  'hostname; date; cat /etc/os-release; uptime; ss -tulpen | sed -n "1,140p"; systemctl list-unit-files --state=enabled --no-pager'
```

Expected for a clean VPS:

- Debian 12.
- SSH listening on the provider port.
- No existing service listening on the selected UDP port.
- No existing `/etc/hysteria` service unless the task is an audit or rotation.

If the user asks whether a node already exists, check process names, listening ports, systemd units, Docker containers, and common config directories before installing:

```bash
ps -eo pid,ppid,user,etimes,cmd --sort=cmd | grep -Ei '(hysteria|xray|v2ray|sing-box|trojan|shadowsocks|mihomo|clash|nezha|frp)' | grep -v grep || true
ss -tulpen | sed -n '1,160p'
systemctl list-units --all --type=service --no-pager | grep -Ei '(hysteria|xray|v2ray|sing-box|trojan|shadowsocks|mihomo|clash|nezha|frp)' || true
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
for p in /etc/hysteria /etc/xray /etc/v2ray /etc/sing-box /etc/shadowsocks* /etc/nezha /etc/frp; do [ -e "$p" ] && ls -ld "$p"; done
```

## Install Hysteria2

Run on the remote host:

```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl ca-certificates openssl

if ! command -v hysteria >/dev/null 2>&1; then
  bash <(curl -fsSL https://get.hy2.sh/)
fi

install -d -m 0750 /etc/hysteria
AUTH_PASSWORD="$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | cut -c1-32)"
OBFS_PASSWORD="$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | cut -c1-32)"
```

For a self-signed certificate:

```bash
SERVER_NAME="<hostname-or-domain>"
PUBLIC_IP="<ip>"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -keyout /etc/hysteria/server.key \
  -out /etc/hysteria/server.crt \
  -days 3650 -nodes \
  -subj "/CN=${SERVER_NAME}" \
  -addext "subjectAltName=DNS:${SERVER_NAME},IP:${PUBLIC_IP}"
```

For a real domain certificate, use ACME or a certificate already managed by the operator. Keep Hysteria2's `tls.cert` and `tls.key` pointed at the real certificate paths, and do not set client `insecure: true`.

## Server Config

Write `/etc/hysteria/config.yaml`:

```yaml
listen: :443

tls:
  cert: /etc/hysteria/server.crt
  key: /etc/hysteria/server.key
  sniGuard: disable

auth:
  type: password
  password: <auth_password>

obfs:
  type: salamander
  salamander:
    password: <obfs_password>

masquerade:
  type: proxy
  proxy:
    url: https://www.bing.com/
    rewriteHost: true
```

Apply ownership and start the service:

```bash
chmod 0640 /etc/hysteria/config.yaml /etc/hysteria/server.key
chmod 0644 /etc/hysteria/server.crt
if id hysteria >/dev/null 2>&1; then
  chown -R hysteria:hysteria /etc/hysteria
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 443/udp
fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=443/udp
  firewall-cmd --reload
fi

systemctl daemon-reload
systemctl enable --now hysteria-server.service
systemctl restart hysteria-server.service
sleep 1
```

## Verification

Run before handoff:

```bash
systemctl is-enabled hysteria-server.service
systemctl is-active hysteria-server.service
systemctl --no-pager --full status hysteria-server.service | sed -n '1,40p'
journalctl -u hysteria-server.service -n 80 --no-pager
ss -ulpen | grep ':443'
```

The service log should contain `server up and running` with `listen: :443`.

If external clients fail, distinguish service configuration from UDP reachability:

```bash
# On the server: same-host client check. This proves the Hysteria2 config itself works.
tmpdir=$(mktemp -d)
trap 'kill ${PID:-0} >/dev/null 2>&1 || true; rm -rf "$tmpdir"' EXIT
cat >"$tmpdir/client.yaml" <<'EOF'
server: 127.0.0.1:443
auth: <auth_password>

tls:
  sni: <server_name>
  insecure: true

obfs:
  type: salamander
  salamander:
    password: <obfs_password>

socks5:
  listen: 127.0.0.1:10888
EOF
hysteria client --config "$tmpdir/client.yaml" >"$tmpdir/client.log" 2>&1 &
PID=$!
for i in $(seq 1 30); do
  ss -tlpen | grep -q ':10888' && break
  sleep 0.2
done
sed -n '1,80p' "$tmpdir/client.log"
curl --max-time 15 --socks5-hostname 127.0.0.1:10888 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|colo|http|tls)='
```

If same-host Hysteria2 succeeds but an outside client times out, check provider-side UDP ingress before rewriting the config. ByteVirt hosts may have no local iptables/nft rules while upstream UDP is still closed. Ask the user to confirm the cloud console allows inbound UDP on the selected port, especially UDP `443`.

Use an application-layer UDP listener to test ingress if needed:

```bash
# Remote shell
python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 443))
s.settimeout(8)
try:
    data, addr = s.recvfrom(2048)
    print("RECV", addr, data.decode("utf-8", "replace"))
except Exception as exc:
    print("NO_RECV", type(exc).__name__, str(exc))
PY
```

From the local machine while the listener is running:

```bash
printf 'hy2-test' | nc -u -w1 <ip> 443
```

## Shadowrocket Handoff

For self-signed TLS, produce both a YAML snippet and a `hy2://` link. Use `insecure: true` in YAML and `insecure=1` in the link.

```yaml
server: <ip>:443
auth: <auth_password>

tls:
  sni: <server_name>
  insecure: true

obfs:
  type: salamander
  salamander:
    password: <obfs_password>
```

Shadowrocket import link:

```text
hy2://<auth_password>@<ip>:443/?sni=<server_name>&insecure=1&obfs=salamander&obfs-password=<obfs_password>#<label>
```

Some clients accept `hysteria2://` while Shadowrocket commonly accepts `hy2://`; provide `hy2://` first.

After the user imports the link, verify through browser checks:

- `https://ip.sb` should show the VPS public IP and ByteVirt ASN/ISP.
- `https://www.cloudflare.com/cdn-cgi/trace` should show `ip=<vps-ip>`.

If Shadowrocket's node row does not show a latency value, do not treat that alone as a node failure. For Hysteria2, Shadowrocket's built-in connectivity display can be blank or unstable while the proxy is working. Check the server log first:

```bash
journalctl -u hysteria-server.service -n 80 --no-pager | grep -E 'client connected|client disconnected|TCP error' || true
```

If the log shows `client connected` from the user's public address and browser trace shows `ip=<vps-ip>`, the proxy path is working. Suggest changing Shadowrocket's connectivity test URL to:

```text
https://cp.cloudflare.com/generate_204
```

Alternative:

```text
https://www.gstatic.com/generate_204
```

Before blaming the node, test those URLs from the VPS:

```bash
for u in https://cp.cloudflare.com/generate_204 https://www.gstatic.com/generate_204 https://www.cloudflare.com/cdn-cgi/trace; do
  printf '== %s ==\n' "$u"
  curl -4 -L -sS -o /dev/null -w 'code=%{http_code} time=%{time_total} remote=%{remote_ip}\n' --max-time 8 "$u" || true
done
```

## Rotation and Audit

To rotate credentials, generate new `AUTH_PASSWORD` and `OBFS_PASSWORD`, update `/etc/hysteria/config.yaml`, restart `hysteria-server.service`, and provide a new import link. Do not reuse old links in final reports.

When auditing an existing host, report separately:

- Service state: systemd active/enabled, process, listening UDP port.
- Local configuration health: config parse/start logs and same-host Hysteria2 client check.
- External reachability: provider UDP ingress and user-side client result.
- Client artifact: whether Shadowrocket import link matches the live server config.
