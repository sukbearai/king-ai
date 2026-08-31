# Trade Intelligence

`king-ai trade` is a **local market-intelligence sensor/daemon** (not the multi-agent collaboration workflow). It runs alert rules, morning brief, Twitter collection, and a process watchdog inside one supervisor. The stack uses **OpenCLI + tg + local agent + Yahoo** with seven default rules under stable ids: `treasury`, `meme_large`, `stocks`, `celebrity`, `ticker_velocity`, `discord_wba`, `panews`; the `kimpremium` Korea leverage-risk rule is opt-in.

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
~/.king-ai/trade/state/kimpremium_latest.json
~/.king-ai/trade/state/kimpremium_snapshots.jsonl
~/.king-ai/trade/state/robinhood_chain.sqlite
~/.king-ai/trade/state/robinhood_chain_phase1.sqlite
~/.king-ai/trade/state/robinhood_chain_phase2.sqlite
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
| `alerts.llm_advice` | Append a plain-language investment memo to every outgoing warning/critical Telegram alert (default `false`) |
| `alerts.confluence.enabled` | Promote info→warning when multiple rules share the same **non-empty** asset (default `true`). Legacy key: `alerts.confluence_enabled` |
| `alerts.confluence.window_seconds` | Confluence lookback window (default `900`). Legacy: `alerts.confluence_window_seconds` |
| `alerts.rule_stagger_ms` | Delay between rules in one poll round (default `1000`) |
| `briefing.enabled` | Morning brief sections, such as `market`, `stocks`, `telegram`, `twitter`, `leaderboard`, `pumpfun` |
| `briefing.schedule_hour` | Morning brief cron hour (local, default `5`) |
| `verify.step_timeout_ms` | Per-source timeout for `verify-tg` (overrides per-rule defaults when set) |
| `data_sources.pumpfun` | Pump.fun section filters and limits |
| `data_sources.leaderboard` | Smart-money leaderboard options |
| `data_sources.robinhood_chain` | Opt-in read-only Robinhood Chain Phase 0 collector and retention settings |
| `data_sources.robinhood_chain.phase1.phase2` | Opt-in local shadow-draft and 72-hour readiness ledger |
| `treasury` | Treasury stress: `^TYX` / `^TNX` / `TLT` thresholds |
| `kimpremium` | Korea leverage KPIs, polling, and thresholds (disabled by default) |
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
| `kimpremium` | — | Korea retail-leverage KPIs, daily moves, and historical volatility percentiles (opt-in) |

### Alert pipeline

```text
rule.check → regime cap → confluence (asset only) → JSONL audit → TG severity gate → daily cap (by ruleId) → optional LLM guidance → push
```

- Info-level alerts are always written to JSONL; Telegram defaults to `warning` and above.
- Daily push caps and cooldowns key on **canonical `ruleId`**, not display names.
- Confluence only considers alerts with a non-empty `asset` (normalized uppercase); title fallbacks are not used.
- Daemon rule ticks use per-rule timeouts (e.g. celebrity `240s`, panews `120s`); a timeout sets heartbeat `status: timeout` and continues the round.
- Cooldowns persist in `~/.king-ai/trade/rule_state.json`.

Celebrity alpha is **LLM-autonomous** (no human approval): the local agent decides `is_alpha` / `alpha_type` / `confidence` / `entities`. A blank task backend inherits `llm.default_backend`, then `llm.provider`, then Codex, and entries in `llm.disabled_backends` are skipped. Celebrity classification uses Codex in read-only, cwd-independent mode when selected. Code only enforces ledger rails — entity must appear in the tweet text, confidence floors (`alerts.celebrity_tweet.min_confidence_alert` / `min_confidence_warning`), cooldowns, and JSONL audit. Each tick classifies at most eight candidates by default; successful non-alpha results are held for six hours. Malformed JSON retries after 15, 30, then 60 minutes and remains retryable. X collection auth/challenge failures, collection errors, and exhausted agent backends become heartbeat errors rather than healthy no-alert results. Telegram delivery failures are logged after alert audit persistence.

### Kimpremium leverage risk

The first version reads `meta.json`, `series.json`, and `etf.json` directly and does not start Chrome. Add `kimpremium` to `alerts.enabled` to activate it. The rule polls at `kimpremium.poll_seconds` (default `300`) and does not append or push the same `asof/generated` snapshot twice. Risk combines level thresholds with daily-change percentiles over the previous 252 trading days. Two/three consecutive source failures raise warning/critical alerts.

### LLM guidance for Telegram alerts

With `alerts.llm_advice=true`, every warning/critical rule that survives the Telegram severity gate and daily cap invokes `llm.agent_tasks.alert_advice` once for that outgoing batch. The message appends a short plain-language investment memo: what the event means, a directional bias with principles, and what to watch next—not a conservative/neutral/aggressive checklist. Source-health failures are excluded because stale or missing market facts must not produce investment actions.

Code rejects guaranteed-return language, deterministic price calls, all-in/full-position language, and immediate buy/sell instructions for a specific security. If the model is unavailable, throws, or returns non-compliant output, a deterministic local short note is used and the factual alert is still delivered. The output does not know the user's holdings or loss capacity and is not personalized investment advice.

```json
{
  "alerts": { "enabled": ["treasury", "kimpremium"], "llm_advice": true },
  "kimpremium": { "poll_seconds": 300 },
  "llm": { "agent_tasks": { "alert_advice": { "timeout_ms": 45000 } } }
}
```

## Daemon Supervisor

The daemon runs a unified rule scheduler plus scheduled jobs:

- Morning brief (`briefing.schedule_hour`)
- Regime detection
- Twitter collector, opt-in Robinhood Chain collector, and process watchdog

### Robinhood Chain Phase 0

The Robinhood Chain collector is disabled by default. Set `data_sources.robinhood_chain.enabled=true` to collect
confirmed chain activity through read-only JSON-RPC. The daemon samples every 30 seconds by default, validates
chain id `4663`, keeps a bounded confirmed-block cursor, replays a recent overlap for reorg detection, and stores
five-minute block, transaction, unique-sender, contract-creation, and gas aggregates in
`~/.king-ai/trade/state/robinhood_chain.sqlite`.

The default batch permits up to 1,000 blocks with at most 16 concurrent RPC requests. Raw transaction input,
recipient history, wallet keys, signatures, orders, Telegram alerts, LLM advice, and trading actions are outside
Phase 0. Data is retained for 14 days by default. RPC URLs are sanitized before logs or source-health state are
written. A failed partial batch does not advance the durable cursor.

Run one read-only collection manually, even while daemon collection remains disabled:

```sh
king-ai trade collect-robinhood
```

The command prints JSON containing the sanitized endpoint, latest and confirmed target blocks, persisted cursor,
lag, fetched block count, and overlap replacements. Use `packages/cli/trade_config.example.json` for the complete
configuration fields and bounds.

### Robinhood Chain Phase 1 shadow trends

Phase 1 is a second opt-in layer under `data_sources.robinhood_chain.phase1`. Both the parent collector and
`phase1.enabled` must be true for daemon scheduling. Phase 1 remains `delivery=shadow`: it discovers verified
pool creation and swap events through bounded read-only RPC logs, computes five-minute stablecoin-notional,
trader, liquidity, venue-breadth, and data-quality components, and writes deterministic qualified/rejected
candidates to `~/.king-ai/trade/state/robinhood_chain_phase1.sqlite`.

The built-in enabled registry currently covers bytecode-checked Uniswap V2/V3/V4, UP V3, and Metric V1
deployments on Chain ID 4663. Other researched venues remain disabled until their deployment and decoder are
verified. USD notional recognizes the on-chain USDG and USDe legs; pools without a supported pricing or
liquidity observation remain visible but fail closed with quality reasons. V4 pools are discovered from recent
Initialize events, and remain liquidity-unknown until a safe pool-specific liquidity decoder exists.

On the first enabled tick, Phase 1 performs a one-time stablecoin-pool creation bootstrap for the non-V4
registries. It queries only creation-event token positions matching USDG or USDe over a configurable historical
range (`stable_pool_discovery_backfill_blocks`, default 1,000,000), then writes a durable completion marker. This
recovers relevant pools created before the normal cursor without turning every tick into a broad backfill. Swap
processing remains bounded to the normal `max_log_blocks_per_tick` range (default 1,000 blocks), and a failed
bootstrap is retried because the completion marker is not written.

The default 60-second tick can process 1,000 blocks with at most four concurrent log calls. This is above the
approximately 599 blocks per minute observed during the 2026-08-31 capacity sample. Phase 1 does not send
Telegram, invoke an LLM, access a wallet, or place trades. Run one isolated shadow tick manually with:

```sh
king-ai trade collect-robinhood-phase1
```

The manual command always remains read-only and prints only a bounded shadow summary. Live Telegram delivery
requires a separate approval after at least 72 hours of shadow evidence.

The explicit X registry is separately opt-in with `phase1.x_enabled=true`. It searches configured Tier A/B/C
accounts directly rather than assuming that the home timeline covers them, stores bounded post evidence and
per-account health (`ok`, `no_results`, `auth_required`, `challenge`, `unknown`, or `error`), and never creates a
chain trend by itself. Run one account pass with `king-ai trade collect-robinhood-x`.

### Robinhood Chain Phase 2 shadow readiness

Phase 2 is an additional opt-in local evidence layer under `phase1.phase2`. It reads Phase 1 candidates and audit
records, materializes deterministic shadow alert drafts in a separate database, and measures the 72-hour field
gate. It does not rescan the chain or change Phase 1 scores. X posts are attached only when their text contains a
full pool or token address, and can never create a draft.

The default readiness gate requires at least 72 hours, 800 successful runs, no gap above 15 minutes, no more than
5% source errors, at least one audited Phase 1 window, and ten explicitly reviewed shadow drafts. Passing these
checks returns `approval_required`; it does not authorize or enable Telegram delivery.

Readiness is isolated by `phase2.field_run_revision`. Runs, drafts, and reviews from an older revision remain in
SQLite for audit but do not count toward the current 72-hour gate. Bump this revision whenever a material collector,
decoder, threshold, or field configuration change is loaded; otherwise pre-change runtime could be mistaken for
continuous evidence from the final implementation.

Run one materialization pass and inspect the local ledger with:

```sh
king-ai trade collect-robinhood-phase2
king-ai trade robinhood-phase2-status --limit 20
king-ai trade review-robinhood-phase2 <alert-id> accepted --note "review note"
```

For an isolated field run, use a dedicated `KING_AI_CONFIG_DIR` containing only the Robinhood Chain settings and
start `king-ai trade robinhood-shadow-daemon`. This sidecar schedules Phase 0, Phase 1, and Phase 2 sequentially,
uses its own PID lock and SQLite files, and has no Telegram, LLM, wallet, signing, order, or morning-brief path.
Its scheduler wakes every 30 seconds by default while preserving the configured 30/60/300-second phase cadences.

```sh
KING_AI_CONFIG_DIR=~/.king-ai-robinhood-shadow king-ai trade robinhood-shadow-daemon
```

The verdict may be `accepted` or `rejected`. Phase 2 remains `delivery=shadow`, does not invoke an LLM, and does
not access wallets, sign transactions, place orders, or trade. Live delivery requires a separate approval after
the readiness evidence and false-positive samples are reviewed.

Morning brief Telegram delivery writes `[morning-brief] telegram push ok|failed chunks=N` to
`~/.king-ai/trade/logs/daemon.log`, and the latest delivery metadata is stored in
`~/.king-ai/trade/scratchpad.json` under `last_brief_push`.

Telegram channel reads are serialized because `tg` commands share one Telethon session. Child-process failures
are reduced to a bounded diagnostic instead of being copied into a brief. Outgoing messages are limited to ten
Telegram chunks, and delivery stops after the first failed chunk, preventing dependency logs from becoming a
runaway message stream.

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
```

## Auxiliary Commands

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade collect-robinhood
king-ai trade collect-robinhood-phase1
king-ai trade collect-robinhood-x
king-ai trade collect-robinhood-phase2
king-ai trade robinhood-shadow-daemon
king-ai trade robinhood-phase2-status --limit 20
king-ai trade verify-tg --dry-run
king-ai trade verify-celebrity --dry-run
king-ai trade watchdog --kill
king-ai trade signal-quality
king-ai trade signal-quality --days 14 --json
king-ai trade signal-quality --refresh
```

### Signal quality

`king-ai trade signal-quality` scores historical alerts from the JSONL audit log (`~/.king-ai/trade/alerts/alert_log.jsonl`) using OKX 1-hour forward returns at T+4h and T+24h.

| Flag | Meaning |
|------|---------|
| `--days N` | Lookback window in days (default `30`). Only alerts older than 25h are scored so T+24h outcomes exist. |
| `--json` | Print machine-readable JSON instead of the plain-text table |
| `--refresh` | Recompute all outcomes and rewrite `~/.king-ai/trade/state/signal_outcomes.jsonl` |

The table is aggregated **per `rule_id`** plus a `TOTAL` row:

| Column | Meaning |
|--------|---------|
| `alerts` | Eligible audit rows in the window (non-empty `asset`) |
| `pushed` | Rows with severity `warning` or `critical` |
| `priced%` | Share of rows that resolved against OKX candles |
| `hit4h%` / `hit24h%` | Directional hit rate (long hit iff return &gt; 0; short hit iff return &lt; 0; `direction == 0` excluded) |
| `edge4h` / `edge24h` | Average `sign(direction) * return%` over priced directional rows |

Unknown instruments (no OKX candles) are marked `unpriced` and still count toward `alerts` but not hit/edge. Outcomes are cached under `signal_outcomes.jsonl` so re-runs only price new keys unless `--refresh` is set.

`verify-tg` runs each enabled alert rule and each configured morning-brief section once, then pushes one Telegram message per source. Each source is isolated by timeout (shared helper with the daemon). Celebrity verification has a longer default budget unless `verify.step_timeout_ms` is set. Trade AI summaries and PANews classification use the configured local agent CLI chain, with Codex first by default and `llm.disabled_backends` omitted. If every local agent backend is unavailable, morning brief summaries fall back to compacted local text instead of sending the full raw feed.

`verify-celebrity --dry-run` checks each configured celebrity account's X search page and reports readable, no-results, unknown, login-required, challenge, or error states without calling the LLM or Telegram. `unknown` means the search page loaded but did not expose a recognizable tweet/no-results marker; it is reported as a warning, while login-required, challenge, and error still fail the browser health check.

The market brief queries OKX spot/perp endpoints concurrently with short per-request budgets. Crypto rows show signed 24-hour changes and label open interest with its coin unit. Tune `data_sources.market.request_timeout_ms` and `data_sources.market.fallback_timeout_ms` if your local network needs a different balance between freshness and brief latency.

Market, stock, and Treasury rows include the source quote time when the upstream API provides one. A-share indices render as points, Hong Kong symbols use `HK$`, and Treasury price symbols are omitted from the stock watchlist when the Treasury section is enabled. Yahoo-backed stock and Treasury quotes retry once after a transient failure; missing Treasury instruments are marked as degraded, and the rate-cut conclusion is derived from configured move thresholds instead of a fixed narrative.

The Twitter collector samples the authenticated `x.com/home` virtual timeline across multiple scroll rounds and merges tweets before X unmounts older DOM nodes. Tune `data_sources.twitter.collect_limit`, `scroll_rounds`, `scroll_wait_ms`, and `stagnant_rounds` to balance coverage and collection latency. Collector logs distinguish rounds, scanned DOM rows, unique rows, duplicates, new cache entries, recent-24h entries, and recent authors. This remains the visible authenticated home feed, not a complete X archive.

The Twitter brief applies a relevance filter by default. Its section title reports the cache/filter/analyzed funnel. Filtering prefers `$TICKER` cashtags and known trade symbols, hard-blocks game collabs/ads/login noise, and ranks market relevance before raw engagement. In LLM mode, ranked candidates are capped by `data_sources.twitter.llm_max_display` (default `150`), the overall `max_display` ceiling, and `per_author_cap`; non-LLM display continues to use `max_display`. The summary emits at most five trade-relevant judgments and keeps a source index with author, UTC+8 time, and original URL. It is followed by a relevance-first quick list; `data_sources.twitter.quick_list_size` defaults to `10`, and `0` disables it. Set `data_sources.twitter.relevance_filter` to `false` to inspect the raw timeline. Non-meme Telegram summaries emphasize what happened and why it matters; meme summaries prioritize priced buys/sells, liquidity, market cap, and concentration, while referenced Chain.fm token contracts and abbreviated wallets appear in full in the address index. With LLM summaries enabled, `briefing.daily_summary` defaults to `true` and, when at least two sections succeed, writes a plain-language investment memo with risk bias instead of a price-change checklist. Brief sections still run in parallel, but Telegram channels are fetched serially because all `tg` reads share one Telethon session. The stocks section expands movers only by default (equities |Δ|≥5%, index/ETF |Δ|≥3%) and folds the rest; set `briefing.stocks_show_all=true` for the full watchlist. Meme summaries replace insulting wallet nicknames with a neutral「地址」label. Dry-run briefs do not replace the persisted metadata for the latest scheduled or manually delivered brief.

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
