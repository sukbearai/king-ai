#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"

required_markers = [
    "name: digitalocean-cf-vless-deploy",
    "Cloudflare SSL/TLS mode should be `Full (strict)`",
    "If the user only wants VPN, do not ask for a website domain",
    "Use `VLESS + WebSocket + TLS + 443`",
    "`certbot.timer` is the systemd renewal scheduler installed by Certbot",
    "Subscription decodes to `<vpn-domain>:443`",
    "For Shadowrocket, prefer importing the subscription URL",
    "Do not treat preferred IP/CNAME as the first deployment step",
]

missing = []
for path in [SKILL, AGENT]:
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in required_markers if marker not in text)

if missing:
    print("digitalocean-cf-vless-deploy skill validation failed:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

print("digitalocean-cf-vless-deploy skill validation passed")
