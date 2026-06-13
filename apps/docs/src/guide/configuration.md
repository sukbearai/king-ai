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
- `KING_AI_SIGNAL_ALERT_LOG`: override the shared alert JSONL path used by trade rules and accuracy tracking.
- `KING_AI_SIGNAL_OUTPUT_DIR`: override SignalEngine output directory (default `~/.king-ai/trade/signals`).

## Trade Runtime

Trade intelligence uses `~/.king-ai/trade/` for logs, scratchpad weights, signal output, and bundled skills such as PANews. See [Trade Intelligence](/guide/trade) for daemon installation and rule configuration.

## Local Engines

King AI detects installed `claude`, `codex`, and `grok` CLIs. Keep the selected engine signed in locally before starting the daemon, then use:

```sh
king-ai agent computer --doctor
```

to verify engine availability after PATH, login, or quota changes.

Persistent engine sessions have a no-output watchdog. If a local CLI such as Codex or Grok gets stuck behind an interactive login, quota, billing, or credits prompt and produces no engine output, King AI aborts that attempt, resets the affected session, records the attempt in the run attempt ledger, shows it on the run stream card, and schedules one bounded retry for the same unread work or pinned task before backing off. If the retry also fails, King AI posts a clear runtime failure notice; run the engine directly in a local terminal and then re-run `king-ai agent computer --doctor` before waking the agent again.

Grok uses the xAI CLI headless mode (`grok -p`) with `--output-format streaming-json` for turns and `--resume <sessionId>` for session reuse. When a turn includes accepted image attachments, King AI switches to `grok --prompt-json` and sends ACP image content blocks with base64 payloads instead of plain `-p` text. In scripted runs King AI also passes `--no-auto-update` and `--always-approve`. Optional extra flags can be supplied with `KING_AI_GROK_ARGS`.

## IELTS Coach Audio

The GUI Worker uses Cloudflare Workers AI for IELTS coach text-to-speech when the `AI` binding is available. Agent messages show a play button that calls `/gui/tts`, runs `xai/grok-tts`, and streams the generated audio back to the browser. The deployed Cloudflare account must have Workers AI access and enough balance or BYOK configuration.

Playback is scoped to messages from the IELTS coach and to individual word cards opened from those messages. For full-message playback, the browser sends only the readable English portion of the coach reply to TTS and excludes the hidden `WordCards` JSON used for vocabulary and sentence annotations. For word cards, the browser sends only the selected word.

The playback button shows loading, playing, and failure states. Only one reply plays at a time, clicking the active button stops playback, and generated audio is cached in browser memory for the current page session so repeated clicks do not regenerate the same message.

`CLOUDFLARE_AI_GATEWAY_ID` enables Cloudflare AI Gateway routing for the TTS call. The default Worker configuration sets it to `default`, so Workers AI requests are logged and governed by that gateway when the account has it configured. If the `AI` binding is unavailable, `/gui/tts` can fall back to the Cloudflare REST `/ai/run` API using `CLOUDFLARE_ACCOUNT_ID` and the Worker secret `CLOUDFLARE_AI_API_TOKEN`.

The REST fallback is disabled by default and is intended for local debugging or unusual deployments. Set `CLOUDFLARE_AI_REST_FALLBACK=1` only when the Worker cannot use the `AI` binding.

Do not configure the TTS route with an AI Gateway `/compat/chat/completions` URL. That OpenAI-compatible path is for chat completions; TTS uses Workers AI `xai/grok-tts` through the binding or `/ai/run`.
