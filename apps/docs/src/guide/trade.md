# Trade Intelligence

`king-ai trade` is a **local market-intelligence sensor/daemon** (not the multi-agent collaboration workflow). It runs alert rules, morning brief, Twitter collection, and a process watchdog inside one supervisor. The stack uses **OpenCLI + tg + local agent + Yahoo** with seven rules under stable ids: `treasury`, `meme_large`, `stocks`, `celebrity`, `ticker_velocity`, `discord_wba`, `panews`.

Trade and multi-agent collaboration share `~/.king-ai` and local agent CLIs, but **do not share** the task/card/host workflow state machine.

## Quick Start

Copy the example config and install the background service:

```sh
mkdir -p ~/.king-ai
cp path/to/trade_config.example.json ~/.king-ai/trade_config.json
# edit telegram bot_token, push_chat_id, llm keys, watchlists

king-ai trade install-service --push-tg
king-ai trade status
```

`install-service` registers `dev.king-ai-trade` (macOS LaunchAgent or Linux systemd user unit) and starts the daemon.

Foreground debugging:

```sh
king-ai trade daemon --push-tg
```

Only **one** trade daemon instance should run. The process writes `~/.king-ai/trade/state/daemon.pid` and refuses a second live instance.

## Configuration

Primary file: `~/.king-ai/trade_config.json` (override with `KING_AI_TRADE_CONFIG`). Invalid JSON fails daemon startup (fail-fast). A missing file uses built-in defaults.

Important runtime paths:

```text
~/.king-ai/trade_config.json
~/.king-ai/trade/logs/daemon.log
~/.king-ai/trade/scratchpad.json
~/.king-ai/trade/rule_state.json
~/.king-ai/trade/state/daemon.pid
~/.king-ai/trade/skills/panews/cli.mjs
```

Alert audit log and Twitter cache:

```text
~/.king-ai/trade/alerts/alert_log.jsonl
~/.king-ai/trade/state/twitter_cache.jsonl
```

Key config sections:

| Section | Purpose |
|---------|---------|
| `alerts.enabled` | Canonical rule ids (default full slim stack below); legacy short ids still accepted |
| `alerts.poll_seconds` | Unified rule poll interval (default `120`) |
| `alerts.tick_timeout_ms` | Global per-rule tick timeout for the daemon (overrides per-rule defaults when set) |
| `alerts.confluence.enabled` | Promote info→warning when multiple rules share the same **non-empty** asset (default `true`). Legacy key: `alerts.confluence_enabled` |
| `alerts.confluence.window_seconds` | Confluence lookback window (default `900`). Legacy: `alerts.confluence_window_seconds` |
| `alerts.rule_stagger_ms` | Delay between rules in one poll round (default `1000`) |
| `briefing.enabled` | Morning brief sections, such as `market`, `stocks`, `telegram`, `twitter`, `leaderboard`, `pumpfun` |
| `briefing.schedule_hour` | Morning brief cron hour (local, default `5`) |
| `verify.step_timeout_ms` | Per-source timeout for `verify-tg` (overrides per-rule defaults when set) |
| `data_sources.pumpfun` | Pump.fun section filters and limits |
| `data_sources.leaderboard` | Smart-money leaderboard options |
| `treasury` | Treasury stress: `^TYX` / `^TNX` / `TLT` thresholds |
| `llm.agent_tasks.<task>.timeout_ms` | Optional per-task local agent timeout |
| `telegram` | `bot_token` and `push_chat_id` for alert pushes |

See `packages/cli/trade_config.example.json` in the repository for a minimal template.

## Alert Rules

List registered rules (canonical id + legacy + display name):

```sh
king-ai trade alert list
```

Run one rule once (canonical or legacy id):

```sh
king-ai trade alert run panews --once
king-ai trade alert run q --once
king-ai trade alert run ticker_velocity --once --push-tg
```

| Canonical ID | Legacy | Monitor |
|--------------|--------|---------|
| `treasury` | `b` | Treasury selling / yields (`^TYX` 30Y, `TLT` price, Yahoo) |
| `meme_large` | `e` | Meme large buys (`tg` meme链上监控) |
| `stocks` | `f` | Stock watchlist moves (OpenCLI/Yahoo) |
| `celebrity` | `t` | Celebrity tweet alpha (Trump/Musk/CZ by default) |
| `ticker_velocity` | `tm` | Twitter ticker mention velocity |
| `panews` | `q` | PANews events (local agent classification) |
| `discord_wba` | — | Discord WBA channel (OpenCLI browser) |

### Alert pipeline

```text
rule.check → regime cap → JSONL audit → confluence (asset only) → TG severity gate → daily cap (by ruleId) → push
```

- Info-level alerts are always written to JSONL; Telegram defaults to `warning` and above.
- Daily push caps and cooldowns key on **canonical `ruleId`**, not display names.
- Confluence only considers alerts with a non-empty `asset` (normalized uppercase); title fallbacks are not used.
- Daemon rule ticks use per-rule timeouts (e.g. celebrity `240s`, panews `120s`); a timeout sets heartbeat `status: timeout` and continues the round.
- Cooldowns persist in `~/.king-ai/trade/rule_state.json`.

Celebrity tweet parsing retries when the local agent cannot return a valid classification; non-alpha classifications are suppressed briefly and rechecked later. X search pages are classified before waiting for tweet articles, so a loaded no-results page returns an empty result instead of spending the full selector timeout.

## Daemon Supervisor

The daemon runs a unified rule scheduler plus scheduled jobs:

- Morning brief (`briefing.schedule_hour`)
- Regime detection
- Twitter collector and process watchdog

Morning brief Telegram delivery writes `[morning-brief] telegram push ok|failed chunks=N` to
`~/.king-ai/trade/logs/daemon.log`, and the latest delivery metadata is stored in
`~/.king-ai/trade/scratchpad.json` under `last_brief_push`.

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
```

## Auxiliary Commands

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade verify-tg --dry-run
king-ai trade verify-celebrity --dry-run
king-ai trade watchdog --kill
```

`verify-tg` runs each enabled alert rule and each configured morning-brief section once, then pushes one Telegram message per source. Each source is isolated by timeout (shared helper with the daemon). Celebrity verification has a longer default budget unless `verify.step_timeout_ms` is set. Trade AI summaries and PANews classification use the local agent CLI chain (`grok` → `claude` → `codex`) via `llm.default_backend`. If every local agent backend is unavailable, morning brief summaries fall back to compacted local text instead of sending the full raw feed.

`verify-celebrity --dry-run` checks each configured celebrity account's X search page and reports readable, no-results, login-required, challenge, or error states without calling the LLM or Telegram.

The Twitter brief applies a relevance filter by default. Set `data_sources.twitter.relevance_filter` to `false` to inspect the raw timeline.

## OpenCLI Browser Bridge

Twitter timeline, Xueqiu A-shares, and Discord browser scraping use **OpenCLI** so the trade daemon can reuse your logged-in browser session without starting Chrome with a remote debugging port.

```sh
opencli doctor
opencli browser trade-twitter --window background open https://x.com/home
opencli browser trade-twitter --window background wait selector article --timeout 30000
king-ai trade alert run stocks --once --dry-run
```

Keep the OpenCLI browser extension/daemon available and log in to the relevant sites. Sessions: `trade-twitter`, `trade-twitter-search`, `trade-discord`. Xueqiu falls back to Yahoo Finance when the site adapter is unavailable.

## External Dependencies

- `opencli` — Twitter/X, Xueqiu, and Discord browser-backed reads
- `tg` — Telegram channel reads
- `onchainos` — optional smart-money leaderboard and Pump.fun brief sections
- Yahoo Finance HTTP — stock quotes
- Local agent CLI (`grok`, `claude`, or `codex`) — LLM summarization, PANews classification, and celebrity tweet parsing

PANews article fetch uses `~/.king-ai/trade/skills/panews/cli.mjs`. Copy it from the PANews skill if missing.

## Development

```sh
pnpm dev -- trade status
pnpm dev -- trade daemon --push-tg
pnpm dev -- trade verify-tg --dry-run
pnpm dev -- trade verify-celebrity --dry-run
```
