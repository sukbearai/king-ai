#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"

required_markers = [
    "name: bytevirt-reality-node",
    "Prefer a no-panel deployment unless the user explicitly asks for x-ui",
    "Run Xray as a dedicated `xray` system user, not root",
    "Password (PublicKey)",
    "www.cloudflare.com:443",
    "If the service exits with `open /etc/xray/config.json: permission denied`",
    "No `x-ui.service` is present unless explicitly requested",
]

missing = []
for path in [SKILL, AGENT]:
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in required_markers if marker not in text)

if missing:
    print("bytevirt-reality-node skill validation failed:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

print("bytevirt-reality-node skill validation passed")
