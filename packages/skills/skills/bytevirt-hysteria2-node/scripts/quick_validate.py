#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"

required_markers = [
    "name: bytevirt-hysteria2-node",
    "Prefer a no-panel Hysteria2 deployment unless the user explicitly asks for a management panel",
    "Install official Hysteria2 with `https://get.hy2.sh/`",
    "Use password auth plus `salamander` obfuscation by default",
    "hysteria-server.service",
    "server up and running",
    "If same-host Hysteria2 succeeds but an outside client times out",
    "ByteVirt hosts may have no local iptables/nft rules while upstream UDP is still closed",
    "hy2://<auth_password>@<ip>:443/",
    "Some clients accept `hysteria2://` while Shadowrocket commonly accepts `hy2://`",
    "If Shadowrocket's node row does not show a latency value",
    "https://cp.cloudflare.com/generate_204",
    "If the log shows `client connected` from the user's public address and browser trace shows `ip=<vps-ip>`",
]

missing = []
for path in [SKILL, AGENT]:
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in required_markers if marker not in text)

if missing:
    print("bytevirt-hysteria2-node skill validation failed:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

print("bytevirt-hysteria2-node skill validation passed")
