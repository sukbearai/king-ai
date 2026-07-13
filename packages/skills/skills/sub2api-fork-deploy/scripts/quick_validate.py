#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
AGENT = ROOT / "agents" / "openai.yaml"

REQUIRED_MARKERS = [
    "name: sub2api-fork-deploy",
    "com.docker.compose.project.working_dir",
    "If the user explicitly requests `$codex-luna`",
    "Never persist SSH passwords",
    "pg_restore --list",
    "Do not run `/app/sub2api --version` inside the live `sub2api` container",
    "config --format json",
    "--no-deps",
    "--pull never",
    "PostgreSQL and Redis container IDs and start times",
    "`docker compose pull` will fail",
    "Treat official catch-up as image convergence, not rollback",
    "Do not invoke Luna or rebuild an image for same-commit convergence",
    "git merge-base --is-ancestor",
    "Use `latest` for discovery only",
    "docker pull \"$OFFICIAL_IMAGE\"",
    "Keep the custom image until the official image passes the agreed soak period",
    "Do not restore PostgreSQL automatically",
]

missing = []
for path in (SKILL, AGENT):
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))

if not missing:
    text = SKILL.read_text(encoding="utf-8")
    missing.extend(marker for marker in REQUIRED_MARKERS if marker not in text)

if missing:
    print("sub2api-fork-deploy skill validation failed:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

print("sub2api-fork-deploy skill validation passed")
