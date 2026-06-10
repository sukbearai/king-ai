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

## IELTS Coach Audio

The GUI Worker uses Cloudflare Workers AI for IELTS coach text-to-speech when the `AI` binding is available. Agent messages show a play button that calls `/gui/tts`, runs `xai/grok-tts`, and streams the generated audio back to the browser. The deployed Cloudflare account must have Workers AI access and enough balance or BYOK configuration.

Playback is scoped to messages from the IELTS coach and to individual word cards opened from those messages. For full-message playback, the browser sends only the readable English portion of the coach reply to TTS and excludes the hidden `WordCards` JSON used for vocabulary and sentence annotations. For word cards, the browser sends only the selected word.

The playback button shows loading, playing, and failure states. Only one reply plays at a time, clicking the active button stops playback, and generated audio is cached in browser memory for the current page session so repeated clicks do not regenerate the same message.

`CLOUDFLARE_AI_GATEWAY_ID` enables Cloudflare AI Gateway routing for the TTS call. The default Worker configuration sets it to `default`, so Workers AI requests are logged and governed by that gateway when the account has it configured. If the `AI` binding is unavailable, `/gui/tts` can fall back to the Cloudflare REST `/ai/run` API using `CLOUDFLARE_ACCOUNT_ID` and the Worker secret `CLOUDFLARE_AI_API_TOKEN`.

The REST fallback is disabled by default and is intended for local debugging or unusual deployments. Set `CLOUDFLARE_AI_REST_FALLBACK=1` only when the Worker cannot use the `AI` binding.

Do not configure the TTS route with an AI Gateway `/compat/chat/completions` URL. That OpenAI-compatible path is for chat completions; TTS uses Workers AI `xai/grok-tts` through the binding or `/ai/run`.
