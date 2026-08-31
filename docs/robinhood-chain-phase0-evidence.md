# Robinhood Chain Phase 0 Evidence

Date: 2026-08-31
Scope: approved SPEC Revision 2 for the read-only Robinhood Chain shadow collector.

## Delivered behavior

- Added an opt-in `data_sources.robinhood_chain` collector for Chain ID `4663`.
- Added read-only JSON-RPC validation, endpoint failover, URL/error redaction, bounded block reads, predecessor continuity checks, transactional SQLite persistence, durable cursor recovery, overlap replay/reorg replacement, five-minute UTC windows, source health, and retention pruning.
- Added `king-ai trade collect-robinhood` as a manual read-only entry point. `force=true` permits a one-shot manual run while daemon collection remains disabled.
- Added daemon scheduling every 30 seconds by default. The collector runs as an isolated in-flight auxiliary job and does not block watchdog or Twitter work after a collector failure.
- Updated the English and Simplified Chinese trade documentation and the example configuration.
- Phase 0 intentionally does not implement Telegram trade alerts, LLM advice, token/pool discovery, wallet or private-key handling, signatures, orders, or auto-trading.

## Revision 2 capacity evidence

The approved revision records a live read-only RPC sample of 64 blocks over 5 seconds, approximately 12.8 blocks/second or 384 blocks per 30-second interval. The collector therefore defaults to `max_blocks_per_tick=1000` (bounded to 2000) and `rpc_concurrency=16` (bounded to 32).

## Verification results

### RED observations before implementation

The focused Robinhood test module was exercised before the implementation was complete; imports/build behavior failed at the missing collector boundary. These RED observations were used as the implementation gate. The repository has no installed mutation-testing tool, so named negative controls are used instead.

### Focused tests

Command:

```sh
pnpm --filter @suwujs/king-ai build
node --test packages/cli/dist/test/robinhood-chain.test.js
```

Result: 12/12 tests passed, covering configuration bounds, disabled no-database behavior, inactive invalid settings, failover, wrong-chain fail-closed behavior, credential redaction, bounded backfill, bounded concurrency, partial-failure cursor preservation, overlap/reorg replacement, retention, and scheduler failure isolation.

### Repository gates

Commands:

```sh
pnpm lint
pnpm verify
git diff --check
```

`pnpm lint` passed (Biome checked 253 files). `pnpm verify` passed, including CLI, GUI, and docs builds; the CLI suite passed 550/550 tests, the GUI worker suite passed 177/177 tests, and the skill validation/test gates passed. `git diff --check` passed.

### Real RPC smoke

Command shape:

```sh
RH_SMOKE_DIR=$(mktemp -d /tmp/king-ai-rh-smoke-rev2.XXXXXX)
KING_AI_CONFIG_DIR="$RH_SMOKE_DIR" pnpm dev -- trade collect-robinhood
```

The run used a temporary `KING_AI_CONFIG_DIR` and did not touch the user's real `~/.king-ai` configuration. It completed successfully against the public read-only endpoint with:

```json
{
  "status": "persisted",
  "endpoint": "https://rpc.mainnet.chain.robinhood.com",
  "latestBlock": 50573886,
  "targetBlock": 50573866,
  "firstBlock": 50573847,
  "lastBlock": 50573866,
  "persistedBlock": 50573866,
  "lagBlocks": 0,
  "fetchedBlocks": 20,
  "reorgReplacements": 0
}
```

The temporary database was created under `/tmp/king-ai-rh-smoke-rev2.FXhu57/trade/state/robinhood_chain.sqlite` (57,344 bytes at capture time).

## Acceptance boundary

Verified: source compilation, focused behavior, full repository gates, and one real read-only RPC collection in an isolated temporary configuration directory.

Not verified: long-duration operation, provider rate-limit behavior, complete reorg scenarios on live data, an installed/real daemon service run, Windows packaging, field deployment, or any trading/alerting behavior (which is explicitly out of scope for Phase 0).

## Operational rollback

Keep `data_sources.robinhood_chain.enabled` false (the default) or set it to false and restart the trade daemon. The isolated SQLite file is not deleted automatically; deleting runtime data is a separate destructive action requiring explicit authorization.

No commit, push, tag, deployment, or modification of the user's real trade configuration was performed.
