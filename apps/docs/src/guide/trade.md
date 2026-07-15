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
| `alerts.celebrity_tweet.max_classifications_per_tick` | Maximum celebrity LLM classifications per tick (default `8`, range `1..50`) |
| `llm.disabled_backends` | Local agent backends to omit from the fallback chain, for example `["claude"]` |
| `llm.agent_tasks.<task>.backend` | Optional task backend; blank or missing inherits `llm.default_backend`, then `llm.provider`, then Codex |
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

Celebrity alpha is **LLM-autonomous** (no human approval): the local agent decides `is_alpha` / `alpha_type` / `confidence` / `entities`. A blank task backend inherits `llm.default_backend`, then `llm.provider`, then Codex, and entries in `llm.disabled_backends` are skipped. Celebrity classification uses Codex in read-only, cwd-independent mode when selected. Code only enforces ledger rails — entity must appear in the tweet text, confidence floors (`alerts.celebrity_tweet.min_confidence_alert` / `min_confidence_warning`), cooldowns, and JSONL audit. Each tick classifies at most eight candidates by default; successful non-alpha results are held for six hours. Malformed JSON retries after 15, 30, then 60 minutes and remains retryable. X collection auth/challenge failures, collection errors, and exhausted agent backends become heartbeat errors rather than healthy no-alert results. Telegram delivery failures are logged after alert audit persistence.

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

`verify-tg` runs each enabled alert rule and each configured morning-brief section once, then pushes one Telegram message per source. Each source is isolated by timeout (shared helper with the daemon). Celebrity verification has a longer default budget unless `verify.step_timeout_ms` is set. Trade AI summaries and PANews classification use the configured local agent CLI chain, with Codex first by default and `llm.disabled_backends` omitted. If every local agent backend is unavailable, morning brief summaries fall back to compacted local text instead of sending the full raw feed.

`verify-celebrity --dry-run` checks each configured celebrity account's X search page and reports readable, no-results, unknown, login-required, challenge, or error states without calling the LLM or Telegram. `unknown` means the search page loaded but did not expose a recognizable tweet/no-results marker; it is reported as a warning, while login-required, challenge, and error still fail the browser health check.

The market brief queries OKX spot/perp endpoints concurrently with short per-request budgets. Crypto rows show signed 24-hour changes and label open interest with its coin unit. Tune `data_sources.market.request_timeout_ms` and `data_sources.market.fallback_timeout_ms` if your local network needs a different balance between freshness and brief latency.

Market, stock, and Treasury rows include the source quote time when the upstream API provides one. A-share indices render as points, Hong Kong symbols use `HK$`, and Treasury price symbols are omitted from the stock watchlist when the Treasury section is enabled. Yahoo-backed stock and Treasury quotes retry once after a transient failure; missing Treasury instruments are marked as degraded, and the rate-cut conclusion is derived from configured move thresholds instead of a fixed narrative.

The Twitter collector samples the authenticated `x.com/home` virtual timeline across multiple scroll rounds and merges tweets before X unmounts older DOM nodes. Tune `data_sources.twitter.collect_limit`, `scroll_rounds`, `scroll_wait_ms`, and `stagnant_rounds` to balance coverage and collection latency. Collector logs distinguish rounds, scanned DOM rows, unique rows, duplicates, new cache entries, recent-24h entries, and recent authors. This remains the visible authenticated home feed, not a complete X archive.

The Twitter brief applies a relevance filter by default. Its section title reports the cache/filter/analyzed funnel. In LLM mode, ranked candidates are capped by `data_sources.twitter.llm_max_display` (default `150`), the overall `max_display` ceiling, and `per_author_cap`; non-LLM display continues to use `max_display`. The summary emits at most five items and keeps a source index with author, UTC+8 time, and original URL. It is followed by a raw high-engagement quick list; `data_sources.twitter.quick_list_size` defaults to `10`, and `0` disables it. Set `data_sources.twitter.relevance_filter` to `false` to inspect the raw timeline. Telegram meme summaries prioritize priced buys/sells, liquidity, market cap, and concentration; transfer or airdrop lists are compressed and hard-capped, while referenced Chain.fm token contracts and abbreviated wallet addresses are emitted in full in a deterministic address index. With LLM summaries enabled, `briefing.daily_summary` defaults to `true` and adds up to three cross-section highlights when at least two sections succeed, including the current scratchpad market regime and a risk bias. Dry-run briefs do not replace the persisted metadata for the latest scheduled or manually delivered brief.

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
