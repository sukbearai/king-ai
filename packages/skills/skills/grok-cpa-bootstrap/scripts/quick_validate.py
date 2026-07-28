#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"
REQUIRED_FILES = [
    ROOT / "scripts" / "configure_grok_cpa.py",
    ROOT / "scripts" / "audit_stack.py",
    ROOT / "scripts" / "retry_cpa_auth.py",
    ROOT / "tests" / "test_recovery_scripts.py",
    ROOT / "references" / "cloudflare-temp-mail.md",
    ROOT / "references" / "registration-cpa.md",
]
REQUIRED_MARKERS = [
    "name: grok-cpa-bootstrap",
    "Never commit or print API keys",
    "Require explicit user authorization and an exact count",
    "https://github.com/sukbearai/king-ai.git",
    "https://github.com/AaronL725/grok-register.git",
    "https://github.com/dreamhunter2333/cloudflare_temp_email.git",
    "https://github.com/router-for-me/CLIProxyAPI.git",
    "configure_grok_cpa.py",
    "audit_stack.py",
    "retry_cpa_auth.py",
    "personal-team-blocked:spending-limit",
    "invalid_grant: Access denied",
    "--expected-total-auth-count",
    "CPA_OIDC_PROXY",
]


missing = []
for path in (SKILL, AGENT, *REQUIRED_FILES):
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in REQUIRED_MARKERS if marker not in text)

if missing:
    print("grok-cpa-bootstrap skill validation failed:")
    for item in missing:
        print("- %s" % item)
    raise SystemExit(1)

print("grok-cpa-bootstrap skill validation passed")
