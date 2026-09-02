# SPEC - Robinhood Chain Phase 1 Early-Trend Shadow Signals

- Status: approved 2026-08-31; implementation in progress
- Date: 2026-08-31
- Depends on: `docs/robinhood-chain-phase0-spec.md` Revision 2 and its evidence report
- Objective: turn the Phase 0 activity baseline into an evidence-backed early-trend observation loop without placing trades

## Decision requested

Approve Phase 1 as a shadow-first implementation. Approval authorizes schema, read-only discovery, deterministic scoring, and audit output. It does **not** authorize live Telegram alerts, wallet access, signatures, orders, auto-trading, or irreversible external changes until the shadow gate below is passed and a separate alert-enablement decision is recorded.

## Current research snapshot

Read-only public data was checked on 2026-08-31:

- DefiLlama identifies Robinhood Chain as Chain ID `4663`, with TVL about `$716.9M` and circulating stablecoin value about `$774.9M` at capture time.
- DefiLlama's Robinhood Chain DEX overview reported roughly `$1.40B` 24-hour volume, `$6.40B` 7-day volume, and `$16.50B` 30-day volume. The largest reported venues were Uniswap V4, Uniswap V3, Pons V2, Metric V1, Uniswap V2, `up v3`, Ramses CL V2, GIGA V3, Fables, Alandale V3, SushiSwap V3, Orvex, and Arcus Spot.
- These values are external indexer observations, not the Phase 0 authority. They are used to choose an initial allowlist and cross-check local measurements, not as a trading signal.
- Blockscout API access was Cloudflare-challenged from the development environment; Phase 1 therefore keeps configured JSON-RPC and local SQLite as authority and treats external indexers as comparison-only.

The snapshot is time-sensitive and must be refreshed before enabling any live signal.

## Product boundary

Phase 1 closes this loop:

```text
read-only RPC logs/calls + explicit protocol registry
  -> new pool/token observations
  -> 5-minute deterministic metrics
  -> risk gates and score
  -> shadow signal + evidence/audit
  -> (later, separately approved) Telegram + LLM explanation
```

The model may explain an already-qualified signal, but it may not create a signal, override a risk gate, or issue a deterministic buy/sell instruction.

## Implementation slices

### 1A - Discovery and normalization (shadow only)

Extend the collector with bounded `eth_getLogs` and read-only contract calls for an explicit protocol registry. The first registry is limited to verified factory/router/event definitions for Uniswap V2/V3/V4, Pons, Metric, `up`, Ramses, GIGA, Fables, Alandale, Sushi, Orvex, and Arcus. A protocol is disabled until its factory address, event signature, and chain-4663 deployment are verified from primary project documentation or bytecode.

Persist only normalized facts needed for metrics:

- pool address, protocol id, creation block/time, token0/token1 where available;
- liquidity/add/remove events and swap event totals by pool/window;
- unique trader/sender counts by pool/window;
- source block range, endpoint, decode version, and event quality flags.

Do not persist full transaction input, private data, arbitrary calldata, or unbounded logs. Unknown event layouts are recorded as `unclassified` and never promoted to a signal.

### 1B - Deterministic trend and risk metrics (shadow only)

Compute UTC 5-minute windows and compare each pool/asset against its own trailing history:

- volume acceleration: current 5m volume versus trailing 1h and 24h medians;
- trader acceleration: unique traders and new traders versus trailing baselines;
- liquidity change: net liquidity change and drawdown after a new-pool event;
- venue breadth: same asset appearing in more than one verified venue;
- data quality: RPC lag, decode completeness, stale price/liquidity observations.

Initial candidate score is a transparent weighted sum, for example:

`trend_score = volume_acceleration + trader_acceleration + venue_breadth - liquidity_drawdown - data_quality_penalty`

Weights and thresholds remain configuration, are bounded, and are not enabled for Telegram until calibrated from shadow data. A score is not a probability and is not an instruction to trade.

### 1C - Safety gates

Every candidate must pass all hard gates before it can be classified as a qualified trend:

- confirmed block range and no source-health error;
- verified protocol/pool decoder and complete required fields;
- minimum liquidity and minimum observed notional, configured per venue class;
- no severe liquidity withdrawal or immediate pool invalidation;
- no duplicate/replayed observation and no unresolved reorg impact;
- asset identity and decimals are consistent across observations.

Holder concentration, mint/blacklist controls, honeypot simulation, proxy-admin risk, and contract audit status are separate risk dimensions. They are not inferred from a volume spike and remain `unknown` until a dedicated read-only implementation exists.

## Twitter/X source design

The existing collector observes the authenticated home timeline and is not a complete account archive. Phase 1 adds an explicit account registry and health state; it does not silently treat homepage visibility as account coverage.

Initial account tiers:

- Tier A, user-provided leadership/product watchlist entries plus official accounts: `vladtenev`, `BaijuBhatt`,
  `JohannKerbrat`, `fern`, `abhishekf96`, `GrantBradford`, `RobinhoodCrypto`, and `RobinhoodApp`.
- Tier B, explicitly monitored sponsor, early-alpha, amplification, and analytics accounts: `23XIRacing`, `yeon_`,
  `kenjidgn`, `PhilOnChai`, `Wolves_Techml`, `GuarEmperor`, `KookCapitalLLC`, `Cyril_Cryptt`, `cypherpunkgod`,
  `theunipcs`, `CryptoKaleo`, `blknoiz06`, `Mrbankstips`, `eliz883`, `Arnold__AI`, and `FloorWatchRH`.
- Tier B, verified core infrastructure: `Uniswap`, `Morpho`, `LayerZero`, `Lighter_xyz`, `Paxos` and Chainlink-related official accounts.
- Tier C, active venue/project candidates from the research snapshot: `fablesfi`, `alandalexyz`, `giga_dex`, `OrvexFi`, `josephdelong`, `arcus_xyz` and other projects only after handle/domain verification.

Handles are configuration, not truth. Each account requires an identity record containing canonical URL, verification source, last successful search time, and challenge/login status. A candidate X post can enrich a chain signal, but cannot create one by itself. The collector must report `login_required`, `challenge`, `no_results`, `unknown`, and `error` distinctly.
Account search covers authored posts only; follow and like actions require a separate proven source and are not inferred.

## Storage and audit contract

Use a new isolated Phase 1 database or versioned tables; do not migrate the Phase 0 schema in place until a separate compatibility decision exists. Required concepts:

- `protocol_registry` and `account_registry`;
- `pools` and normalized token identities;
- `pool_windows` / `asset_windows` with metric provenance;
- `trend_candidates` with score components, gate outcomes, and state (`observed`, `qualified`, `rejected`, `stale`);
- `signal_audit` containing source ranges, decoder version, config revision, and deterministic reason codes.

All writes are idempotent by chain id + block/log identity and window key. Reorg replacement recomputes affected windows and invalidates dependent candidates. Retention defaults to 30 days for normalized metrics and 7 days for rejected candidates; bounds are required.

## Shadow gate before live delivery

1. Run discovery and scoring with `delivery=shadow` for at least 72 hours and preferably 7 days covering multiple market regimes.
2. Record candidate count, qualified count, rejection reasons, data gaps, RPC error rate, median collection latency, and signal overlap with external indexer volume.
3. Review false-positive samples manually. No score threshold is promoted from a single day.
4. Only after the evidence review, create a separate decision for `delivery=telegram` with per-severity cooldowns and a daily cap.
5. If LLM explanation is enabled later, it receives immutable evidence JSON and must return uncertainty, invalidation risks, and source links; failure falls back to the deterministic message and never suppresses a qualified risk alert.

## Configuration proposal

```json
{
  "data_sources": {
    "robinhood_chain": {
      "enabled": false,
      "phase1": {
        "enabled": false,
        "delivery": "shadow",
        "window_seconds": 300,
        "discovery_seconds": 60,
        "initial_backfill_blocks": 1000,
        "max_log_blocks_per_tick": 1000,
        "log_rpc_concurrency": 4,
        "min_liquidity_usd": 25000,
        "min_volume_5m_usd": 10000,
        "retention_days": 30
      }
    }
  }
}
```

`phase1.enabled` must remain false until discovery tests, live read-only smoke, and the 72-hour shadow gate pass. `delivery` accepts only `shadow` initially; `telegram` requires the separate decision described above.

## Must NOT

- No wallet/private-key access, signatures, orders, transaction broadcasting, or auto-trading.
- No unaudited token contract is promoted merely because it trends on X or has volume.
- No external indexer is treated as the source of truth.
- No LLM-generated score, threshold, or buy/sell command.
- No Telegram delivery before shadow evidence and a separate approval.
- No changes to the user's real trade configuration or enabling of the collector by default.

## Verification plan

- Unit tests for protocol/account registry validation, event decoding, bounded log ranges, score component math, hard gates, idempotency, reorg invalidation, and redaction.
- Temporary SQLite integration tests for windows, retention, duplicate logs, and source-health failures.
- Mocked RPC tests for concurrency and partial batch rollback.
- Real read-only RPC smoke in a temporary `KING_AI_CONFIG_DIR` against Chain ID `4663`.
- 72-hour shadow run with no Telegram side effect, followed by evidence review.
- Full `pnpm lint`, `pnpm verify`, and `git diff --check` before any delivery decision.

## Rollback

Set both `data_sources.robinhood_chain.enabled=false` and `phase1.enabled=false`, then restart the daemon. Phase 1 databases are isolated and are not deleted automatically. Any destructive cleanup requires explicit authorization.

## Revisions

- Initial approved revision: shadow-only discovery, deterministic scoring, isolated audit state, and no Telegram/LLM/trading side effects.
- Capacity correction: a second live RPC sample on 2026-08-31 observed 60 blocks over approximately 6.0 seconds, about 9.98 blocks/second or 599 blocks per 60-second Phase 1 interval. Defaults for `initial_backfill_blocks` and `max_log_blocks_per_tick` are therefore 1000 (maximum 2000), so one healthy tick has capacity above the observed arrival rate.
