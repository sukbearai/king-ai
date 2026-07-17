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
~/.king-ai/trade_config.json
~/.king-ai/trade/
~/.king-ai/trade/state/daemon.pid
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
- `KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS`: watchdog for persistent engine turns that produce no visible output. The default is `300000` (5 minutes); set `0` to disable.
- `KING_AI_SESSION_TIMEOUT_MS`: optional hard timeout for a persistent engine turn. It is disabled by default.
- `KING_AI_TURN_TIMEOUT_MS`: optional hard timeout for one-shot engine runs. It is disabled by default.
- `KING_AI_TRADE_CONFIG`: override the trade config path (default `~/.king-ai/trade_config.json`).
- `KING_AI_ALERT_LOG`: override the alert JSONL audit log path written by trade rules.
- `KING_AI_SHARED_SKILLS`: one or more directories that directly contain shared skill folders. Use the platform path delimiter, or commas, between multiple roots. The daemon copies every child directory with a `SKILL.md` into each agent home before starting the local engine.
- `KING_AI_SKILL_SNAPSHOTS_DIR`: optional directory for activation snapshots that record the exact shared skill files installed for a run.


## Trade Runtime

Trade intelligence uses `~/.king-ai/trade/` for logs, scratchpad state, alert audit logs, and bundled skills such as PANews. See [Trade Intelligence](/guide/trade) for daemon installation and rule configuration.

## Shared Skills

Shared skills let an operator mount a curated set of external procedures into every local agent home without bundling those procedures into the King AI package. This is useful for private team skills or third-party skill packs such as AI Builder Club.

The directory named by `KING_AI_SHARED_SKILLS` must directly contain skill folders:

```text
/path/to/shared-skills/
├── dev-local-setup/
│   └── SKILL.md
└── new-loop/
    └── SKILL.md
```

For an AI Builder Club checkout next to this repository, enable it with:

```sh
eval "$(pnpm skills:aibc:env)"
pnpm dev -- agent computer
```

On this machine the helper resolves to:

```sh
export KING_AI_SHARED_SKILLS='/Users/fayon/workspace/github/skills/skills/skills'
```

You can pass another root when the checkout lives elsewhere:

```sh
eval "$(pnpm skills:aibc:env /path/to/aibc/skills)"
```

At startup the daemon installs shared skills into `.claude/skills`, `.codex/skills`, and `.grok/skills` under each per-agent home. It also writes an activation snapshot under `.king-ai/skill-snapshots`, or under `KING_AI_SKILL_SNAPSHOTS_DIR` when configured, so a run can be audited against the exact skill contents it received.

## Local Engines

King AI detects installed `claude`, `codex`, and `grok` CLIs. Keep the selected engine signed in locally before starting the daemon, then use:

```sh
king-ai agent computer --doctor
```

to verify engine availability after PATH, login, or quota changes.

Persistent engine sessions are scoped by GUI conversation window when a turn is pinned to exactly one conversation. This keeps follow-up context inside the same window while preventing a newly created window from inheriting another window's local model transcript. Background agenda work and turns that span multiple conversations use the default per-agent session.

Agents with a structured reply contract pass its JSON Schema through each engine's native interface. Codex app-server turns use `turn/start.outputSchema`, while one-shot Codex runs write a private schema file and pass `codex exec --output-schema <file>`. Claude runs use resumable one-shot print mode with `--output-format json --json-schema <schema>` because its persistent stream does not accept a per-turn schema. Grok turns switch to `--output-format json --json-schema <schema>` and read the returned `structuredOutput`; ordinary Grok turns continue using `streaming-json`.

Persistent engine sessions have a no-output watchdog. If a local CLI such as Codex or Grok gets stuck behind an interactive login, quota, billing, or credits prompt and produces no engine output, King AI aborts that attempt, resets the affected session, records the attempt in the run attempt ledger, shows it on the run stream card, and schedules one bounded retry for the same unread work or pinned task before backing off. If the retry also fails, King AI posts a clear runtime failure notice and shows the remediation in the GUI model status panel; run the engine directly in a local terminal and then re-run `king-ai agent computer --doctor` before waking the agent again.

Grok uses the xAI CLI headless mode (`grok -p`) with `--output-format streaming-json` for ordinary turns and `--resume <sessionId>` for session reuse. When a turn includes accepted image attachments, King AI switches to `grok --prompt-json` and sends ACP image content blocks with base64 payloads instead of plain `-p` text. In scripted runs King AI also passes `--no-auto-update` and `--always-approve`. Optional extra flags can be supplied with `KING_AI_GROK_ARGS`.

Agent runtime settings in the GUI include an optional **Reasoning effort** field. Leave it blank to use the selected engine default. For Grok agents, set it to `low`, `medium`, or `high` to pass `--reasoning-effort <value>` to the local `grok` CLI. Claude and Codex adapters do not consume this setting; if it is configured for a non-Grok effective engine, the daemon reports a warning and ignores the value.

## IELTS Coach Audio

The GUI Worker uses Cloudflare Workers AI for IELTS coach text-to-speech when the `AI` binding is available. Agent messages show a play button that calls `/gui/tts`, runs `xai/grok-tts`, and streams the generated audio back to the browser. The deployed Cloudflare account must have Workers AI access and enough balance or BYOK configuration.

Playback is scoped to messages from the IELTS coach and to individual word cards opened from those messages. For full-message playback, the browser sends only the readable English portion of the coach reply to TTS and excludes the hidden `WordCards` JSON used for vocabulary and sentence annotations. For word cards, the browser sends only the selected word.

The playback button shows loading, playing, and failure states. Only one reply plays at a time, clicking the active button stops playback, and generated audio is cached in browser memory for the current page session so repeated clicks do not regenerate the same message.

`CLOUDFLARE_AI_GATEWAY_ID` enables Cloudflare AI Gateway routing for the TTS call. The default Worker configuration sets it to `default`, so Workers AI requests are logged and governed by that gateway when the account has it configured. If the `AI` binding is unavailable, `/gui/tts` can fall back to the Cloudflare REST `/ai/run` API using `CLOUDFLARE_ACCOUNT_ID` and the Worker secret `CLOUDFLARE_AI_API_TOKEN`.

The REST fallback is disabled by default and is intended for local debugging or unusual deployments. Set `CLOUDFLARE_AI_REST_FALLBACK=1` only when the Worker cannot use the `AI` binding.

Do not configure the TTS route with an AI Gateway `/compat/chat/completions` URL. That OpenAI-compatible path is for chat completions; TTS uses Workers AI `xai/grok-tts` through the binding or `/ai/run`.
