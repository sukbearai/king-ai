# SPEC - Robinhood Chain Phase 0 Shadow Collector

- Tier: 3
- Artifact path: `/Users/fayon/workspace/github/pnpm/king-ai/docs/robinhood-chain-phase0-spec.md`
- Source scope: `packages/cli/src/trade/`, `packages/cli/src/paths.ts`, `packages/cli/src/cli.ts`, `packages/cli/test/`, `packages/cli/trade_config.example.json`, `apps/docs/src/guide/trade.md`, `apps/docs/src/zh/guide/trade.md`
- Isolation: 使用当前 worktree；仓库已有未提交的 watchdog 变更，本任务不得覆盖、回退或重写这些变更，只在必要位置做可区分的增量编辑。

## Setup Plan

- Tools or dependencies to add: 无。使用 Node 22 内置 `fetch`、`node:sqlite` 和当前测试框架。
- Persistent files to add or change:
  - 源码中新增 Robinhood Chain 配置、JSON-RPC、SQLite store 和 collector 模块。
  - 运行时仅在显式启用后创建 `~/.king-ai/trade/state/robinhood_chain.sqlite` 及 SQLite WAL/SHM 辅助文件。
  - 不修改或迁移现有 `rule_state.json`、Twitter 数据库、告警日志或用户钱包数据。
- Environment changes: 无。测试与真实 RPC smoke test 使用临时 `KING_AI_CONFIG_DIR`，不得写入现有 `~/.king-ai`。
- Git operations proposed: 无提交、无推送、无标签。
- External or destructive actions proposed: 仅允许对配置中的 Robinhood Chain JSON-RPC 执行只读调用；不部署、不重启现有 daemon、不修改真实 trade 配置、不连接钱包、不签名、不广播交易。

## Product Boundary

Phase 0 只建立可恢复的链活动观测基线：

```text
read-only RPC -> confirmed block aggregates -> SQLite authority -> 5-minute windows -> source health/logs
```

Phase 0 不生成交易告警，不写 `alert_log.jsonl`，不调用 LLM，不生成投资建议，不发现或评价具体 Token/Pool，不执行或模拟交易。后续 Phase 1 必须基于本阶段真实数据和单独批准的阈值设计。

## Authority And Lifecycle

- Authoritative state: `robinhood_chain.sqlite`。
- Owner: trade daemon 中的 Robinhood Chain auxiliary collector；手动 `trade collect-robinhood` 复用同一生产 collector。
- Identity:
  - block: `chain_id + block_number`，同时保存 `block_hash` 和 `parent_hash`；
  - block sender: `block_number + address`；
  - metric window: `window_start`，固定 300 秒 UTC epoch window；
  - collector state: stable key/value rows。
- State transitions:

```text
disabled -> idle
enabled -> checking_source -> collecting -> persisted -> idle
                         |              `-> failed -> idle on next scheduled run
                         `-> wrong_chain -> failed
```

- A failed or timed-out batch must not advance `last_confirmed_block`.
- Source health failure is persisted independently after the block batch rolls back.
- The daemon owns scheduling; the database connection cache remains process-owned and is not closed by one collector tick.

## Configuration Contract

Configuration path: `data_sources.robinhood_chain`.

Supported fields:

- `enabled`: boolean, default `false`.
- `chain_id`: integer, default `4663`; Phase 0 rejects any value other than `4663`.
- `rpc_urls`: non-empty string array; defaults to the official mainnet RPC and PublicNode fallback.
- `collect_seconds`: bounded integer, default `30`, minimum `30`, maximum `3600`.
- `confirmations`: bounded integer, default `20`, minimum `1`, maximum `200`.
- `initial_backfill_blocks`: bounded integer, default `20`, minimum `1`, maximum `500`.
- `max_blocks_per_tick`: bounded integer, default `1000`, minimum `1`, maximum `2000`.
- `rpc_concurrency`: bounded integer, default `16`, minimum `1`, maximum `32`; limits concurrent confirmed-block reads within one atomic batch.
- `reorg_overlap_blocks`: bounded integer, default `20`, minimum `1`, maximum `200`, and not greater than the retained recent block span.
- `retention_days`: bounded integer, default `14`, minimum `7`, maximum `90`.
- `request_timeout_ms`: bounded integer, default `10000`, minimum `1000`, maximum `60000`.

RPC URLs may contain credentials or query tokens. Logs, CLI output, health rows and thrown diagnostics must expose only sanitized origins/hosts, never user-info, query strings or fragments.

## SQLite Contract

The store creates and owns these tables:

- `collector_state(key PRIMARY KEY, value, updated_at)`
- `chain_blocks(block_number PRIMARY KEY, block_hash UNIQUE, parent_hash, block_ts, tx_count, contract_creations, gas_used, observed_at)`
- `block_senders(block_number, address, tx_count, PRIMARY KEY(block_number, address))`
- `activity_windows(window_start PRIMARY KEY, window_end, block_count, tx_count, unique_senders, contract_creations, gas_used, updated_at)`
- `source_health(source PRIMARY KEY, status, endpoint, latest_block, target_block, lag_blocks, consecutive_failures, last_success_at, last_error_at, last_error)`

SQLite requirements:

- WAL and bounded busy timeout use the existing `openSqliteDb` production path.
- Foreign keys are enabled for this database, and deleting/replacing a block cannot leave orphan `block_senders` rows.
- A collected batch is applied in one explicit transaction.
- Reprocessing overlap deletes and replaces rows for those block heights, then recomputes every affected five-minute window from authoritative `chain_blocks` and `block_senders` rows.
- Retention pruning deletes block/window data older than `retention_days`, but never deletes collector cursor or source health.
- Schema creation is idempotent. Phase 0 introduces a new database and performs no migration of existing user databases.

## Scenarios

Feature: 安全采集 Robinhood Chain 已确认区块活动

Scenario: 首次运行只回补有限区块
  Given collector 已启用且数据库没有 cursor
  And RPC reports chain id 4663 and latest block N
  When collector runs with 20 confirmations and initial backfill 20
  Then target block is N-20
  And at most the last 20 confirmed blocks are fetched and atomically persisted
  And `last_confirmed_block` becomes the highest persisted block
  And no Telegram message, alert audit row or transaction is produced

Scenario: 重启后从 durable cursor 有界追赶
  Given persisted `last_confirmed_block` is C
  And confirmed target is greater than C
  When collector runs
  Then it refetches the configured overlap and advances by at most `max_blocks_per_tick`
  And a later run resumes from the new durable cursor
  And already observed blocks do not duplicate window metrics

Scenario: collector capacity exceeds observed chain growth
  Given Robinhood Chain was observed growing at approximately 12.8 blocks per second on 2026-08-31
  When the daemon collects every 30 seconds with default configuration
  Then the per-tick range permits up to 1000 blocks and therefore exceeds the observed approximately 384-block arrival rate
  And block RPC reads use at most 16 concurrent requests
  And results are sorted and validated as one continuous block range before any durable batch write

Scenario: overlap 中 block hash 改变
  Given a stored block height has hash A
  And the RPC now returns hash B for the same confirmed height
  When overlap is collected
  Then the old block and sender rows are replaced transactionally
  And affected windows are recomputed without double counting
  And a reorg replacement count is recorded in collector state or structured result

Scenario: exact five-minute activity aggregation
  Given several blocks span one or more UTC five-minute windows
  When they are persisted
  Then each window contains exact block count, transaction count, unique sender count, contract creation count and gas used derived from stored block data

Scenario: RPC failover
  Given the first endpoint times out or returns a JSON-RPC error
  And a later endpoint returns valid chain 4663 data
  When collector runs
  Then it completes through the healthy endpoint
  And output identifies only the sanitized endpoint

Scenario: wrong chain is fail-closed
  Given every reachable endpoint reports a chain id other than 4663
  When collector runs
  Then no block batch or cursor is written
  And source health becomes `error`
  And the diagnostic states the expected and observed chain ids without secrets

Scenario: partial block fetch failure
  Given some blocks in a planned batch were fetched
  And a required later block cannot be fetched from any endpoint
  When collector fails
  Then none of that batch is persisted
  And the previous cursor remains authoritative
  And consecutive source failures increase by one

Scenario: daemon integration is opt-in
  Given `data_sources.robinhood_chain.enabled` is absent or false
  When trade daemon starts
  Then the collector is never invoked and no Robinhood database is created
  Given it is true
  When the configured interval elapses
  Then one collector tick runs without blocking later watchdog or Twitter ticks after failure

Scenario: manual production entry point
  Given a temporary config directory and valid read-only RPC access
  When `king-ai trade collect-robinhood` runs once
  Then it prints a bounded summary containing endpoint, latest/target/persisted block and lag
  And exits non-zero on wrong-chain or complete source failure

## Must NOT

- Must NOT write to existing `~/.king-ai` during tests or the real-RPC smoke test.
- Must NOT enable the collector by default or modify the user's real trade configuration.
- Must NOT connect to a wallet, request signatures, broadcast transactions, place orders or implement auto-trading.
- Must NOT call LLM backends or depend on their availability.
- Must NOT use Blockscout HTML/API as an authority; Phase 0 authority is configured JSON-RPC plus local durable state.
- Must NOT store full transaction input, value, recipient history or other unnecessary per-transaction payloads. Only block aggregates and normalized sender counts required for activity metrics are retained.
- Must NOT log RPC credentials, full tokenized URLs, raw stack dumps containing URLs, or unbounded JSON-RPC bodies.
- Must NOT advance cursor on a partial or failed batch.
- Must NOT double count blocks or senders after restart, duplicate invocation or overlap replay.
- Must NOT create trade alerts, Telegram pushes or alert advice in Phase 0.
- Must NOT overwrite or reformat the user's existing watchdog worktree changes.

## Failure Model (Tier 3)

| Failure mode | User or system impact | Falsifying layer |
| --- | --- | --- |
| Wrong RPC chain accepted | Robinhood metrics silently contain another chain | Unit test for chain-id validation and CLI failure integration |
| Cursor advances after partial failure | Permanent data gap after restart | Transactional store integration test with injected fetch failure |
| Duplicate overlap data | False trend inflation | Restart/overlap integration test asserting stable block and window totals |
| Reorg replacement leaves stale senders | False active-address count | Hash replacement integration test and foreign-key assertions |
| Unbounded initial backfill | RPC overload, large disk use, long daemon stall | Config boundary tests and bounded-call-count collector test |
| Collector throughput stays below chain growth | Cursor lag grows forever and Phase 0 never reaches current data | Real RPC rate sample plus bounded-concurrency catch-up test |
| Unbounded retained data | Disk growth impacts host | Retention integration test using deterministic timestamps |
| RPC secret appears in logs/state | Credential disclosure | Sanitization unit tests covering user-info, query and fragment URLs |
| Collector failure blocks supervisor | Twitter/watchdog jobs stop running | Scheduled auxiliary tick isolation test with injected collector rejection |
| Disabled config still writes state | Unexpected external calls and disk mutation | Daemon scheduling test with invocation spy/temp directory |
| Metrics are not exact across windows | Bad baseline and later false alerts | Deterministic block fixture integration test |
| Concurrent/replayed collection corrupts SQLite | Lost or inconsistent durable state | Idempotent repeated-run integration test under WAL path |
| Live RPC assumptions differ from fixtures | Local tests pass but production input is rejected | Read-only real-RPC smoke test in temporary config directory |

## Planned Gauntlet

| Claim or risk | Layer | Command or scenario | What it cannot prove |
| --- | --- | --- | --- |
| Config bounds and URL redaction | Unit | compiled focused Robinhood test file | Real RPC availability |
| JSON-RPC validation/failover and bounded concurrency | Unit with mocked fetch | compiled focused Robinhood test file | Provider uptime or rate limits |
| Atomic cursor, replay, reorg and retention | Module integration with real temporary SQLite | compiled focused Robinhood test file | Long-duration disk behavior |
| Daemon opt-in/isolation wiring | Module integration using injected collector/scheduled tick seam | compiled scheduler test | Installed LaunchAgent/systemd behavior |
| CLI production entry point | Assembled CLI against fake RPC and temporary config | compiled CLI-focused test or subprocess scenario | Real endpoint behavior |
| Current public RPC schema compatibility | Read-only smoke | temporary `KING_AI_CONFIG_DIR` plus `pnpm dev -- trade collect-robinhood` | Continuous field uptime and all provider failure modes |
| Type, format and repository regression | Static/full suite | `pnpm lint`, `pnpm verify`, `git diff --check` | Deployment or production daemon operation |
| Test sensitivity | RED observations plus explicit wrong-chain, duplicate and cursor negative controls | focused tests observed failing before implementation | General mutation completeness; no repository mutation tool exists |

Mutation testing is `UNAVAILABLE` unless an already installed repository-compatible tool is discovered. It is substituted by approved RED observations and named negative controls; this lowers assurance against unimagined implementation defects but not the specifically mapped failure modes.

## Documentation

The implementation must update English and Simplified Chinese Trade documentation together, covering:

- opt-in status and Phase 0 boundary;
- config fields and defaults;
- SQLite location and retained data;
- daemon schedule and manual collection command;
- no alerts, advice, wallet or trading in Phase 0;
- read-only RPC and source-health behavior.

## Rollback

- Disable `data_sources.robinhood_chain.enabled` and restart the trade daemon.
- Code rollback removes the auxiliary scheduler and CLI entry point; existing unrelated trade behavior remains unchanged.
- The SQLite file is not automatically deleted. Removal of runtime data is a separate destructive action and requires explicit user authorization.
- No database downgrade is required because Phase 0 uses a new isolated database and no existing format is migrated.

## Revisions

- Initial revision: 2026-08-31. Defines the smallest end-to-end Phase 0 collector with durable recovery, bounded retention, opt-in daemon wiring and no trading behavior.
- Revision 2: 2026-08-31. Live read-only RPC sampling observed 64 blocks in 5 seconds (approximately 12.8 blocks/second, or 384 blocks per 30-second interval). The original default `max_blocks_per_tick=100` could not catch up. Increase the default/range to `1000/2000` and add bounded `rpc_concurrency=16` so collection capacity exceeds observed production growth without unbounded requests. Implementation must pause for approval of this revision before changing the approved behavior.
