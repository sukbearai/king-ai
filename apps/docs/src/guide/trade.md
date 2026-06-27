# Trade Intelligence

`king-ai trade` runs alert rules, morning brief, Twitter collection, and process watchdog inside one supervisor daemon. The stack uses **OpenCLI + tg + local agent + Yahoo** with seven rules: `b`, `e`, `f`, `t`, `tm`, `discord_wba`, `q`.

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

## Configuration

Primary file: `~/.king-ai/trade_config.json` (override with `KING_AI_TRADE_CONFIG`).

Important runtime paths:

```text
~/.king-ai/trade_config.json
~/.king-ai/trade/logs/daemon.log
~/.king-ai/trade/scratchpad.json
~/.king-ai/trade/rule_state.json
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
| `alerts.enabled` | Rule IDs to poll; defaults to `b`, `e`, `f`, `t`, `tm`, `discord_wba`, `q` |
| `alerts.poll_seconds` | Unified rule poll interval (default `120`) |
| `alerts.confluence_enabled` | Per-asset confluence promotion inside rule ticks (default `true`) |
| `alerts.rule_stagger_ms` | Delay between rules in one poll round (default `1000`) |
| `briefing.enabled` | Morning brief sections, such as `market`, `stocks`, `telegram`, `twitter`, `leaderboard`, `pumpfun` |
| `briefing.schedule_hour` | Morning brief cron hour (local, default `5`) |
| `data_sources.pumpfun` | Pump.fun section: `stage` (default `MIGRATED`), `limit`, market-cap/holder/volume/Top10 filters; human-readable lines plus LLM summary |
| `data_sources.leaderboard` | Smart-money leaderboard: `chains`, `limit`, `time_frame`, `sort_by`; human-readable lines plus LLM summary |
| `treasury` | Treasury stress: `^TYX` (30Y), `^TNX` (10Y), `TLT` price; period-high and basis-point spike alerts |
| `llm.agent_tasks.<task>.timeout_ms` | Optional per-task local agent timeout, for example `celebrity_extract` |
| `telegram` | `bot_token` and `push_chat_id` for alert pushes |

See `packages/cli/trade_config.example.json` in the repository for a minimal template.

## Alert Rules

List registered rules:

```sh
king-ai trade alert list
```

Run one rule once:

```sh
king-ai trade alert run q --once
king-ai trade alert run tm --once --push-tg
```

| ID | Monitor |
|----|---------|
| `b` | Treasury selling / yields (`^TYX` 30Y, `TLT` price, Yahoo) |
| `e` | Meme large buys (`tg` meme链上监控) |
| `f` | Stock watchlist moves (OpenCLI/Yahoo) |
| `t` | Celebrity tweet alpha (Trump/Musk/CZ by default) |
| `tm` | Twitter ticker mention velocity |
| `q` | PANews events (local agent classification) |
| `discord_wba` | Discord WBA channel (OpenCLI browser) |

Info-level alerts are written to JSONL; Telegram pushes default to `warning` and above. Alert cooldowns persist in `~/.king-ai/trade/rule_state.json`.

## Daemon Supervisor

The daemon runs a unified rule scheduler plus scheduled jobs:

- Morning brief (`briefing.schedule_hour`)
- Regime detection
- Twitter collector and process watchdog

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
king-ai trade watchdog --kill
```

`verify-tg` runs each enabled alert and brief source once (seven rules + the configured brief sections) and pushes one Telegram message per source. Trade AI summaries and PANews classification use the local agent CLI chain (`grok` → `claude` → `codex`) via `llm.default_backend`.

## OpenCLI Browser Bridge

Twitter timeline, Xueqiu A-shares, and Discord browser scraping use **OpenCLI** so the trade daemon can reuse your logged-in browser session without starting Chrome with a remote debugging port.

```sh
opencli doctor
opencli browser trade-twitter --window background open https://x.com/home
opencli browser trade-twitter --window background wait selector article --timeout 30000
king-ai trade alert run f --once --dry-run
```

Keep the OpenCLI browser extension/daemon available and log in to the relevant sites in the browser session. The trade daemon uses stable `trade-twitter`, `trade-twitter-search`, and `trade-discord` browser sessions for Twitter and Discord reads. Xueqiu is attempted through OpenCLI with background/persistent settings, then quickly falls back to Yahoo Finance when the site adapter is unavailable.

## External Dependencies

Trade rules call local CLIs when available:

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
```
