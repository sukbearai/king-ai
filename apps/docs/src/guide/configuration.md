# Configuration

## Local Home

New installs store local runtime state under:

```text
~/.king-ai
```

You can override this path for tests or isolated development:

```sh
KING_AI_CONFIG_DIR=/tmp/king-ai-dev king-ai agent computer --doctor
```

Use `~/.king-ai` for user-facing setup and documentation.

## Important Files

```text
~/.king-ai/computer.json
~/.king-ai/agents/
~/.king-ai/sessions/
~/.king-ai/triage/
~/.king-ai/running.json
~/.king-ai/heartbeat.json
~/.king-ai/host-events.ndjson
~/.king-ai/host-runs.ndjson
```

- `computer.json` stores the paired server URL, computer ID, tenant ID, and device token.
- `agents/` contains per-agent homes and generated runtime files.
- `sessions/` and `triage/` hold local model-session and triage state.
- `running.json` and `heartbeat.json` describe the currently running daemon.
- Host event logs are append-only local audit files.

Treat this directory as sensitive because it contains runtime tokens and local execution state.

## Environment Variables

- `KING_AI_CONFIG_DIR`: override the local home.
- `KING_AI_SERVER_URL`: override the default runtime server URL. The production default is `https://king-ai.congrongtech.cn`.
- `KING_AI_TEAM_ROLE`: provide an actor role for host command governance.
- `KING_AI_AGENT_WORKSPACE_ROOT`: constrain or point agent workspace preparation in development.

## Local Engines

King AI detects installed `claude` and `codex` CLIs. Keep the selected engine signed in locally before starting the daemon, then use:

```sh
king-ai agent computer --doctor
```

to verify engine availability after PATH, login, or quota changes.
