# Trade Intelligence

`king-ai trade` replaces the legacy `trade-agent` stack: alert rules, morning brief, Twitter collection, accuracy tracking, weekly review, and process watchdog run inside one supervisor daemon. `king-ai signal` runs the multi-source SignalEngine fusion scan.

## Quick Start

Copy the example config and install the background service:

```sh
mkdir -p ~/.king-ai
cp path/to/trade_config.example.json ~/.king-ai/trade_config.json
# edit telegram bot_token, push_chat_id, llm keys, watchlists

king-ai trade install-service --push-tg
king-ai trade status
```

`install-service` registers `dev.king-ai-trade` (macOS LaunchAgent or Linux systemd user unit), unloads legacy `com.trade-agent.*` plists when present, and starts the daemon.

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
~/.king-ai/trade/signals/signal_log.jsonl
~/.king-ai/trade/skills/panews/cli.mjs
```

Shared alert history (compatible with the old accuracy tracker):

```text
~/.onchainos/strategies/alerts/alert_log.jsonl
```

Key config sections:

| Section | Purpose |
|---------|---------|
| `alerts.enabled` | Rule IDs to poll (`a`–`u`, `s`, `t`, `tm`, optional `discord_wba`) |
| `alerts.poll_seconds` | Rule loop interval (default `120`) |
| `alerts.aggregator_seconds` | Multi-rule correlation window (default `300`) |
| `signals.scan_seconds` | SignalEngine interval inside daemon; `0` disables auto scan |
| `briefing.schedule_hour` | Morning brief cron hour (local, default `5`) |
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
| `a` | BTC/ETH/SOL price moves |
| `b` | Funding rates |
| `c` | Smart-money clusters |
| `d` | Polymarket shifts |
| `e` | Meme large buys / new tokens |
| `f` | Stock watchlist moves |
| `g` | Options flow |
| `h` | Stablecoin flows |
| `i` | Whale transfers |
| `j` | VIX spike / elevated |
| `k` | MA breakdown / breakout |
| `l` | RSI extremes |
| `m` | Bollinger squeeze / breakout |
| `n` | Liquidation cascade |
| `o` | Gas spikes |
| `p` | Macro news (Bloomberg) |
| `q` | PANews events |
| `r` | Long/short ratio |
| `s` | Subscribed wallet addresses |
| `t` | Celebrity tweet alpha (Trump/Musk/CZ by default) |
| `tm` | Twitter ticker mention velocity |
| `u` | BTC ETF flows (also scheduled daily at 22:00) |
| `discord_wba` | Discord WBA channel (requires Chrome CDP; see below) |

Info-level alerts are written to JSONL; Telegram pushes default to `warning` and above.

## Daemon Supervisor

The daemon runs all enabled rule loops plus scheduled jobs:

- Morning brief (`briefing.schedule_hour`)
- Rule `u` once daily at 22:00
- Weekly review Sundays at 06:00
- Alert aggregator, optional SignalEngine scan, regime detection
- Twitter collector, alert-accuracy cycle, process watchdog

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
king-ai trade unload-legacy --remove
```

## SignalEngine

Manual fusion scan:

```sh
king-ai signal scan
king-ai signal scan --push-tg --threshold 0.3
king-ai signal scan --sources smart_money,technical,event
```

Enable automatic scans in config:

```json
"signals": { "scan_seconds": 600 }
```

Output: `~/.king-ai/trade/signals/signal_log.jsonl` and `latest_scan.txt`.

## Auxiliary Commands

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade accuracy --stats
king-ai trade watchdog --kill
king-ai trade weekly-review --push-tg
```

## Chrome CDP (replaces opencli)

Twitter timeline, Xueqiu A-shares, and Discord browser scraping use **Chrome DevTools Protocol** against your logged-in Chrome:

```sh
# macOS: quit Chrome fully, then restart your daily profile with debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Set `KING_AI_CHROME_CDP_URL` (default `http://127.0.0.1:9222`) or `data_sources.chrome.cdp_url` in `trade_config.json`. The trade daemon **attaches to open tabs** in that Chrome (preferring existing x.com / xueqiu.com / discord.com pages) and reuses your logged-in session.

## External Dependencies

Trade rules call local CLIs when available:

- `onchainos` — on-chain data
- `surf` — market tickers, funding, options
- `tg` — Telegram channel reads
- Gemini API or `claude` / `codex` — LLM summarization and PANews classification

PANews article fetch uses `~/.king-ai/trade/skills/panews/cli.mjs`. Copy it from the PANews skill if missing.

## Development

```sh
pnpm dev -- trade status
pnpm dev -- trade daemon --push-tg
pnpm dev -- signal scan
```