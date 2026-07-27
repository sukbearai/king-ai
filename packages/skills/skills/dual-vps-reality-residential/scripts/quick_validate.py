#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"

required_markers = [
    "name: dual-vps-reality-residential",
    "Do not point A's default route at B",
    "Fail closed: if WireGuard is down, marked proxy traffic must fail, not fall back to A's datacenter IP",
    "Table = off",
    '"mark": 102',
    "Be honest about IP type",
    "existing Reality on A was preserved",
    "mark102 = `<b-ip>`",
    "Do not include SSH passwords, Reality private keys, or WireGuard private keys",
    "Related Skills",
]

missing = []
for path in [SKILL, AGENT]:
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in required_markers if marker not in text)

if missing:
    print("dual-vps-reality-residential skill validation failed:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

print("dual-vps-reality-residential skill validation passed")
