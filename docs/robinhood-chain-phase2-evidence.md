# Robinhood Chain Phase 2 Evidence

Date: 2026-08-31
Scope: approved local shadow-readiness implementation; no live delivery.

## Implemented

- Added `robinhood-chain-phase2.ts` as a read-only consumer of the Phase 1 SQLite database.
- Added isolated `robinhood_chain_phase2.sqlite` storage for run history, shadow alert drafts, append-only human reviews, and readiness checks.
- Added deterministic draft materialization with stable IDs, score strength labels, immutable Phase 1 provenance, and exact-address X enrichment.
- Added strict readiness gates: 72 hours, 800 successful runs, 15-minute maximum gap, 5% source-error ceiling, audited Phase 1 windows, and ten reviewed drafts.
- Added CLI commands for materialization, status inspection, and explicit accepted/rejected review records.
- Added opt-in daemon scheduling under `phase1.phase2`; all defaults remain disabled and `delivery` is hard-limited to `shadow`.
- Added a durable `field_run_revision` partition. Material source, decoder, threshold, or field-configuration
  changes can start a new evidence epoch while retaining prior rows for audit; only the active revision contributes
  to readiness duration, run count, drafts, and review count.
- Added an isolated `robinhood-shadow-daemon` for the field run. It has a dedicated PID lock and state root, runs
  Phase 0 -> Phase 1 -> Phase 2 sequentially, continues to Phase 2 after an upstream collection failure so source
  errors remain measurable, and contains no delivery integration.
- Added English/Chinese trade documentation and a proposed decision record.

## Focused verification

```sh
pnpm --filter @suwujs/king-ai build
node --test packages/cli/dist/test/robinhood-chain-phase2.test.js
node --test packages/cli/dist/test/robinhood-shadow-daemon.test.js
```

Result: 12/12 Phase 2 tests and 5/5 isolated shadow-daemon tests passed. Coverage includes configuration bounds,
disabled no-database behavior, missing/unhealthy Phase 1 fail-closed behavior, idempotent draft materialization,
exact-address X enrichment, X-only rejection, stale invalidation, readiness success and failure gates, append-only
review history, field-run revision isolation, legacy schema migration, bounded notes, status inspection, sequential
phase execution, failure continuation, schedule cadence, fail-closed startup, and PID-lock release.

The related focused Robinhood suites passed 44/44 tests (15 Phase 1, 12 Phase 2, 12 Phase 0, and
5 shadow-daemon tests). The CLI entry points were exercised against copied/generated Phase 1
databases in temporary `KING_AI_CONFIG_DIR` directories. The stale source correctly returned `source_unhealthy`
with no drafts, while a fresh qualified fixture supported materialization, explicit CLI review, and status
inspection. Both paths kept `liveDeliveryAuthorized=false`.

## Repository gates

The final Phase 2 source, tests, configuration, documentation, and decision files must pass:

```sh
pnpm lint
pnpm verify
git diff --check
```

These gates prove local source/build/test and documentation assembly only. They do not prove a 72-hour real daemon run or authorize Telegram delivery.

Final staged-snapshot result on 2026-08-31: `pnpm lint` passed for 257 files; `pnpm verify` passed with CLI 577/577,
GUI 177/177, and all skills validation/tests; `git diff --check` passed. The decision validator also passed for
the proposed Phase 2 decision record.

## Safety boundary

Phase 2 never sends Telegram, invokes an LLM, accesses wallets, signs transactions, broadcasts transactions, places orders, or trades. X posts cannot create, score, or qualify a chain alert. `approval_required` is an evidence state only and always reports `liveDeliveryAuthorized=false`.

## Not yet verified

An isolated field run started at 2026-08-31 13:49:31 +08:00 under `~/.king-ai-robinhood-shadow`, supervised by
LaunchAgent `dev.king-ai-robinhood-shadow`. A real one-shot and supervised restarts persisted Phase 0, Phase 1, and
Phase 2 data. Because the stable-pool bootstrap and readiness-epoch isolation materially changed the evidence path,
the final field revision is `phase2-v3-readiness-epoch` and started at 2026-08-31 14:37:44 +08:00. Its first run is
1/1 successful with zero source errors, 220 audited Phase 1 windows, no shadow alerts, no reviews, and
`liveDeliveryAuthorized=false`. Earlier `legacy` and `phase2-v2-stable-pool-bootstrap` rows remain preserved for
audit but do not count toward this revision. The service is running as PID 25686; the existing `dev.king-ai-trade`
service remains PID 97500 and was not restarted or reconfigured.

The one-time `pool_discovery_bootstrap_v1=1` marker is present. V3 collection continued to grow after bootstrap,
including priced swaps with non-null stablecoin-balance liquidity. Current candidates remain rejected by the
existing hard gates; no threshold was lowered to manufacture an alert.

- completion of the 72-hour continuous shadow period and 800 successful runs;
- public RPC/X provider rate limits and authentication/challenge behavior;
- a representative ten-alert manual false-positive review sample;
- any Telegram or LLM delivery path;
- production installation, Windows, field, or trading acceptance.

Live delivery requires a separate human decision after the readiness evidence and false-positive samples are reviewed.
