---
name: dual-vps-reality-residential
description: "Use when chaining two VPS hosts so a CN-friendly line machine A terminates VLESS Reality Vision and a second machine B provides the final public egress over WireGuard: preserve an existing Reality inbound on A when present, install policy-routed residential or landing egress with fail-closed fwmark routing, verify exit IP and IP-type honesty, and hand off without leaking SSH passwords or private keys."
---

# Dual VPS Reality + Landing Egress

Use this skill when the user wants a two-box path like:

```text
client -> A:443 VLESS + Reality + Vision -> WireGuard -> B NAT egress -> internet
```

Typical labels:

- **A / line machine**: optimized China path such as CN2 GIA / ByteVirt / other entry VPS.
- **B / landing machine**: final public egress. Prefer true residential or ISP-like IP when the user asks for residential. Do not call a datacenter VPS "residential" just because it is the second hop.

Prefer a no-panel deployment on A unless the user already runs `x-ui`/`3x-ui` and asks to keep it. Do not store provider passwords, UUIDs, Reality private keys, WireGuard private keys, or complete live node links in the skill.

## Required Inputs

- **A**: public IPv4, SSH port, user, auth method.
- **B**: public IPv4, SSH port, user, auth method.
- Desired role assignment. Default: ByteVirt / CN-optimized host = A, cheaper US/EU host = B.
- Whether A already has a Reality node that must be preserved.
- Whether B is claimed to be residential. If claimed, verify with public IP databases before handoff language uses "residential".

Debian 11/12 are acceptable. Prefer Debian 12 for new hosts.

## Safety Defaults

- Never persist SSH passwords into the skill, git, or long-lived local files.
- Prefer `sshpass`/`expect` only for one-shot bootstrap; encourage key auth after first login.
- On A, keep the existing Reality inbound when the user says to retain it. Add WireGuard and routing around it instead of recreating the node.
- Do not point A's default route at B. Only marked Xray traffic may use the WireGuard table.
- Fail closed: if WireGuard is down, marked proxy traffic must fail, not fall back to A's datacenter IP.
- On B, require a real VPS with root, TUN/WireGuard, and NAT rights. A pure SOCKS/HTTP account is not enough for this skill.
- Do not print WireGuard private keys or Reality private keys in the final answer.
- Be honest about IP type: Cogent/AS174, cloud ASN, `hosting`/`Business`/`Data Center` labels are not residential.

## Architecture Rules

```text
A responsibilities:
  - Accept client Reality traffic
  - Terminate first hop
  - Mark Xray egress with fwmark 102
  - Policy-route mark 102 into table 166 via wg-out
  - Keep SSH/system traffic on A's own NIC

B responsibilities:
  - Initiate WireGuard to A when B has unstable inbound UDP
  - Enable IPv4 forward
  - NAT 10.77.0.0/24 out B's public interface
  - Provide the final public IP seen by websites
```

Protocol placement:

- China client -> A: `VLESS + REALITY + Vision` on TCP 443.
- A -> B: WireGuard only, preferably inside the same region or low-latency path.
- Do not put WireGuard on the China first hop by default. Fixed UDP fingerprints are a poor first-hop choice on easy-to-identify paths.

## Preflight

From the local machine, inspect both hosts.

A:

```bash
SSHPASS='<a-password>' sshpass -e ssh -4 \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password \
  -o NumberOfPasswordPrompts=1 \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  -p <a-ssh-port> root@<a-ip> \
  'hostname; cat /etc/os-release; ss -tulpen | sed -n "1,160p"; ip -4 addr; ip route; ip rule; ps -eo pid,user,cmd | grep -Ei "xray|x-ui|sing-box" | grep -v grep || true; ls -la /etc/xray /usr/local/etc/xray /etc/x-ui 2>/dev/null || true'
```

B:

```bash
SSHPASS='<b-password>' sshpass -e ssh -4 \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password \
  -o NumberOfPasswordPrompts=1 \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  -p <b-ssh-port> root@<b-ip> \
  'hostname; cat /etc/os-release; ss -tulpen | sed -n "1,120p"; ip -4 addr; ip route; sysctl net.ipv4.ip_forward; command -v wg || true'
```

If password auth fails under `sshpass` but works interactively, use `expect` for A/B bootstrap. Some hosts accept the password only through a real PTY prompt.

### Detect existing Reality on A

Look for:

- process `/usr/local/bin/xray` or `xray run -config ...`
- listener on `*:443`
- config paths such as `/usr/local/etc/xray/config.json` or `/etc/xray/config.json`
- inbound tag resembling `vless-reality-443`
- `streamSettings.security = reality`

If present and the user says keep it:

- Do not reinstall Xray casually.
- Do not rotate UUID/privateKey/shortId unless asked.
- Backup the live config before editing:

```bash
cp -a /path/to/config.json /path/to/config.json.bak.$(date +%Y%m%d%H%M%S)
```

If A has no proxy yet and the user wants a fresh first hop, use `$bytevirt-reality-node` first, then return to this skill for the B hop.

## Choose and Judge B IP Type

Before calling B residential, check at least two sources:

```bash
IP=<b-ip>
curl -sS --max-time 10 "https://ipinfo.io/${IP}/json"
curl -sS --max-time 10 "http://ip-api.com/json/${IP}?fields=status,country,regionName,city,isp,org,as,asname,mobile,proxy,hosting,query"
curl -sS --max-time 10 "https://proxycheck.io/v2/${IP}?vpn=1&asn=1&risk=1"
```

Interpret conservatively:

- `hosting=true`, `type=Business`, cloud ASN, or transit ASN such as Cogent `AS174` => **not residential**.
- True residential usually looks like consumer ISP names, residential/user-type labels, and no obvious hosting/VPN marks.
- MaxMind-style "residential" is probabilistic. ASN alone never guarantees unlock success.

If the user asked for residential and B is datacenter/business, say so clearly and still complete the dual-hop if they accept "landing egress" instead of "residential egress".

## Install WireGuard

On both hosts:

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y wireguard wireguard-tools
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
```

Generate keys once per host and exchange only public keys.

Suggested tunnel addressing:

```text
A wg-out: 10.77.0.1/24
B wg-out: 10.77.0.2/24
A ListenPort: 51820/udp
```

### A `/etc/wireguard/wg-out.conf`

```ini
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = <a-private>
Table = off

[Peer]
PublicKey = <b-public>
AllowedIPs = 0.0.0.0/0, ::/0
```

`Table = off` is mandatory. If omitted, `AllowedIPs = 0.0.0.0/0` can steal A's default route and break SSH/Reality return paths.

### B `/etc/wireguard/wg-out.conf`

Prefer B initiating to A when B inbound UDP is unreliable:

```ini
[Interface]
Address = 10.77.0.2/24
PrivateKey = <b-private>
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -C POSTROUTING -s 10.77.0.0/24 -o <b-public-iface> -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.77.0.0/24 -o <b-public-iface> -j MASQUERADE; iptables -C FORWARD -i wg-out -o <b-public-iface> -j ACCEPT 2>/dev/null || iptables -A FORWARD -i wg-out -o <b-public-iface> -j ACCEPT; iptables -C FORWARD -i <b-public-iface> -o wg-out -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -i <b-public-iface> -o wg-out -m state --state RELATED,ESTABLISHED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s 10.77.0.0/24 -o <b-public-iface> -j MASQUERADE 2>/dev/null || true; iptables -D FORWARD -i wg-out -o <b-public-iface> -j ACCEPT 2>/dev/null || true; iptables -D FORWARD -i <b-public-iface> -o wg-out -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true

[Peer]
PublicKey = <a-public>
Endpoint = <a-ip>:51820
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 25
```

Detect `<b-public-iface>` with:

```bash
ip -4 route show default | awk '{print $5; exit}'
```

Keep B's `AllowedIPs` limited to `10.77.0.1/32` so B itself does not route its whole OS through the tunnel.

Persist forward on B:

```bash
cat >/etc/sysctl.d/99-residential-exit.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
net.ipv6.conf.all.forwarding=0
EOF
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-residential-exit.conf
```

Enable:

```bash
systemctl enable --now wg-quick@wg-out
```

Open UDP `51820` on A if a host firewall is active. Many cloud hosts need the provider security group/console rule as well.

## A Policy Routing Fail-Closed

Create `/usr/local/sbin/xray-egress-guard`:

```bash
#!/bin/bash
set +e
TABLE=166
MARK=102

while ip rule del fwmark ${MARK} table ${TABLE} 2>/dev/null; do :; done
ip rule add fwmark ${MARK} table ${TABLE} priority 100
while ip -6 rule del fwmark ${MARK} table ${TABLE} 2>/dev/null; do :; done
ip -6 rule add fwmark ${MARK} table ${TABLE} priority 100 2>/dev/null || true

ip route flush table ${TABLE} 2>/dev/null || true
ip -6 route flush table ${TABLE} 2>/dev/null || true
ip route add unreachable default metric 100 table ${TABLE} 2>/dev/null || true
ip -6 route add unreachable default metric 100 table ${TABLE} 2>/dev/null || true

if ip link show wg-out >/dev/null 2>&1; then
  ip link set wg-out up 2>/dev/null || true
  ip route add default dev wg-out metric 10 table ${TABLE} 2>/dev/null || true
  ip route add 10.77.0.0/24 dev wg-out table ${TABLE} 2>/dev/null || true
fi
exit 0
```

```bash
chmod +x /usr/local/sbin/xray-egress-guard
```

systemd oneshot:

```ini
# /etc/systemd/system/xray-egress-guard.service
[Unit]
Description=Xray landing egress policy routing (fail-closed)
After=network-online.target
Wants=network-online.target
Before=wg-quick@wg-out.service xray.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/xray-egress-guard

[Install]
WantedBy=multi-user.target
```

WireGuard drop-in must not fail the unit on guard refresh:

```ini
# /etc/systemd/system/wg-quick@wg-out.service.d/override.conf
[Unit]
After=xray-egress-guard.service
Wants=xray-egress-guard.service

[Service]
ExecStartPost=
ExecStartPost=-/usr/local/sbin/xray-egress-guard
ExecStopPost=
ExecStopPost=-/usr/local/sbin/xray-egress-guard
```

Make xray wait for the guard:

```ini
# /etc/systemd/system/xray.service.d/20-egress-guard.conf
[Unit]
After=xray-egress-guard.service
Wants=xray-egress-guard.service
```

```bash
systemctl daemon-reload
systemctl enable --now xray-egress-guard.service
systemctl restart wg-quick@wg-out
/usr/local/sbin/xray-egress-guard
```

Expected:

```bash
ip rule | grep 0x66   # mark 102
ip route show table 166
# default dev wg-out metric 10
# unreachable default metric 100
ip route get 1.1.1.1 mark 102
# dev wg-out table 166 src 10.77.0.1
```

## Update Xray on A Without Destroying Reality

Edit the live config path discovered in preflight. Keep the existing Reality inbound intact.

Required additions:

1. Outbound `residential` / `landing` with sockopt mark 102.
2. Routing rule from the Reality inbound tag to that outbound.
3. Leave a `direct` outbound for host-local needs if already present.

Example shape when inbound tag is `vless-reality-443`:

```json
{
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "residential",
      "settings": { "domainStrategy": "ForceIPv4" },
      "streamSettings": {
        "sockopt": { "mark": 102 }
      }
    },
    { "protocol": "freedom", "tag": "direct" },
    { "protocol": "blackhole", "tag": "blocked" }
  ],
  "routing": {
    "domainStrategy": "AsIs",
    "rules": [
      {
        "type": "field",
        "inboundTag": ["vless-reality-443"],
        "outboundTag": "residential"
      },
      {
        "type": "field",
        "ip": ["geoip:private"],
        "outboundTag": "blocked"
      }
    ]
  }
}
```

Notes:

- Put `residential` first in the outbounds list when practical so a routing mistake is less likely to silently use unmarked `direct`.
- Do not set both `sockopt.mark` and `interface` to `wg-out` under `Table = off` unless you have verified that combination on the host. Mark + policy routing is the default in this skill.
- `ForceIPv4` avoids IPv6 bypass when B has no residential IPv6 path.
- If Xray runs as `nobody`/`xray`, keep config ownership compatible with that user.
- Validate before restart:

```bash
xray run -test -config /path/to/config.json
systemctl restart xray
```

If the user already uses 3x-ui:

- Prefer native install over Docker for this routing model.
- Create Freedom outbound with mark `102`.
- Route the Reality inbound tag to that outbound.
- Do not enable the inbound for production traffic until WG + guard are verified.

## Verification

### 1. WireGuard handshake

```bash
# on A and B
wg show
```

Expect recent `latest handshake` and bidirectional transfer counters.

### 2. Marked egress is B, direct is A

On A:

```bash
# direct host egress should remain A
curl -4 -s --max-time 10 https://api.ipify.org; echo

# marked 102 must be B. If curl lacks --mark, use a small SO_MARK probe.
python3 - <<'PY'
import socket, ssl
def fetch(mark=None):
    host = "api.ipify.org"
    ip = socket.gethostbyname(host)
    ctx = ssl.create_default_context()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if mark is not None:
        s.setsockopt(socket.SOL_SOCKET, 36, mark)  # SO_MARK
    s.settimeout(12)
    s.connect((ip, 443))
    ss = ctx.wrap_socket(s, server_hostname=host)
    ss.sendall(b"GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
    data = b""
    while True:
        c = ss.recv(4096)
        if not c:
            break
        data += c
    return data.split(b"\r\n\r\n", 1)[-1].decode().strip()
print("direct", fetch(None))
print("mark102", fetch(102))
PY
```

Expected:

- direct = `<a-ip>`
- mark102 = `<b-ip>`

### 3. Fail-closed

```bash
systemctl stop wg-quick@wg-out
wg-quick down wg-out 2>/dev/null || true
ip link del wg-out 2>/dev/null || true
/usr/local/sbin/xray-egress-guard
ip route show table 166   # only unreachable default
# marked connect must fail
# A SSH and direct curl must still work
systemctl start wg-quick@wg-out
/usr/local/sbin/xray-egress-guard
```

If marked traffic still exits as `<a-ip>` after WG is down, the setup is leaking and must not be handed off.

### 4. Reality still healthy

```bash
systemctl is-active xray
ss -tlnp | grep ':443'
# inbound tag/security still reality in config
```

Client import material should remain valid if credentials were preserved. Existing `vless://` links do not need changes solely because egress moved to B.

### 5. Client-side check

After the user connects through the old or new Reality profile:

- `https://api.ipify.org` or `https://ip.sb` should show `<b-ip>`
- Re-check B IP type language against the actual observed exit IP

## Handoff

Report:

- Role map: A line machine IP/SSH port, B landing machine IP/SSH port.
- Whether existing Reality on A was preserved.
- Protocol path: `VLESS + Reality + Vision` then `WireGuard` then `NAT on B`.
- WG status: handshake age, ListenPort, which side initiates.
- Egress proof: direct=A, mark/client exit=B.
- Fail-closed proof summary.
- IP-type honesty: residential / ISP / business / hosting / unknown, with the sources used.
- Config paths touched on A and B.
- Whether client links need rotation. Usually no, if Reality credentials were kept.

Do not include SSH passwords, Reality private keys, or WireGuard private keys.

## Common Failure Modes

- `wg-quick` fails because `xray-egress-guard` returned non-zero from `ip route replace ... File exists`. Make the guard idempotent and use `ExecStartPost=-/usr/local/sbin/xray-egress-guard`.
- A default route stolen by WireGuard because `Table = off` was missing.
- Xray still exits via A because outbound has no `mark: 102`, routing rule missing, or old process not restarted.
- B has no NAT or `ip_forward=0`, so tunnel is up but websites never answer.
- Operator calls LAX/BGP/cloud VPS "residential" after a successful dual hop. Correct the wording even if the chain works.
- Docker on A complicates nft/iptables. This skill still works if you only mark Xray traffic and do not forward whole-host traffic into WG.

## Related Skills

- Fresh first-hop only on ByteVirt: `$bytevirt-reality-node`
- Fresh Hysteria2 first-hop only: `$bytevirt-hysteria2-node`
- Do not mix this dual-hop landing design into those single-node skills unless the user explicitly asks for two machines.
