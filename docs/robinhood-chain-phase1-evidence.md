# Robinhood Chain Phase 1 Evidence

Date: 2026-08-31
Scope: approved Phase 1 shadow implementation; no live delivery.

## Implemented

- Added `robinhood-chain-phase1.ts` with bounded read-only `eth_getLogs` discovery, protocol registry, event decoding, stablecoin notional extraction for USDG/USDe legs, V2 reserve liquidity checks, deterministic trend scoring, hard safety gates, idempotent SQLite windows, retention, reorg-range replacement, candidate records, and signal audit rows.
- Corrected the enabled Uniswap V3 Robinhood factory to `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, matching
  DefiLlama's Robinhood deployment registry. The previous `0x1f98431c...` address is the Ethereum canonical factory,
  not the Chain 4663 deployment.
- Added a one-time stablecoin-filtered creation-event bootstrap for non-V4 protocols. The default historical range
  is 1,000,000 blocks, only USDG/USDe token topic positions are queried, and a durable
  `pool_discovery_bootstrap_v1` marker prevents repetition after a successful batch. Swap processing remains on the
  normal bounded tick range; a failed historical query does not write the marker and therefore retries safely.
- Enabled only bytecode-checked Uniswap V2/V3/V4, UP V3, and Metric V1 definitions on Chain ID 4663. Pons, Ramses, GIGA, Fables, Alandale, SushiSwap, Orvex, and Arcus remain registered but disabled until their deployment/decoder details are verified.
- Added explicit Tier A/B/C X account registry with bounded post evidence and distinct account health states. X observations cannot create a chain signal.
- Added manual commands `king-ai trade collect-robinhood-phase1` and `king-ai trade collect-robinhood-x`.
- Added opt-in daemon jobs. Parent `data_sources.robinhood_chain.enabled`, `phase1.enabled`, and (for X) `phase1.x_enabled` are all required; defaults remain false. Delivery is hard-limited to `shadow`.
- Updated the English and Simplified Chinese trade documentation and example configuration.

## RED-to-GREEN verification

The new focused tests were first run against the absent module and failed at the import/build boundary. After implementation, the following focused suites passed:

```sh
pnpm --filter @suwujs/king-ai build
node --test packages/cli/dist/test/robinhood-chain.test.js \
  packages/cli/dist/test/robinhood-chain-phase1.test.js \
  packages/cli/dist/test/robinhood-chain-phase2.test.js \
  packages/cli/dist/test/robinhood-shadow-daemon.test.js
```

Current focused Phase 1/Phase 2/sidecar verification passes 30/30 tests. Phase 1 coverage includes config bounds,
registry enablement, V2/V4 creation decoding, V2/V3 notional decoding, deterministic gates, strict trailing
1-hour/24-hour baselines, active venue breadth, idempotent/replaced windows, source-error staleness with retained
audit history, monotonic cursor behavior, candidate/audit retention, disabled no-database behavior, bounded shadow
collection, one-time stablecoin bootstrap range/topic filtering, no marker on bootstrap failure, scheduler isolation,
and X account observation persistence.

## Live read-only RPC smoke

Command shape:

```sh
RH_P1_SMOKE_DIR=$(mktemp -d /tmp/king-ai-rh-p1-smoke-final.XXXXXX)
KING_AI_CONFIG_DIR="$RH_P1_SMOKE_DIR" pnpm dev -- trade collect-robinhood-phase1
```

Observed result:

```json
{
  "status": "persisted",
  "delivery": "shadow",
  "endpoint": "https://rpc.mainnet.chain.robinhood.com",
  "latestBlock": 50591809,
  "targetBlock": 50591789,
  "firstBlock": 50590790,
  "lastBlock": 50591789,
  "persistedBlock": 50591789,
  "poolsDiscovered": 6,
  "swapsObserved": 0,
  "candidatesQualified": 0
}
```

The isolated database was `/tmp/king-ai-rh-p1-smoke-final.LsbGqQ/trade/state/robinhood_chain_phase1.sqlite`; registry counts were 13 protocols, 15 accounts, and 6 discovered pools. No Telegram, LLM, wallet, signature, order, or trade call occurred.

## Capacity observation

A second public RPC sample observed 60 blocks over approximately 6.0 seconds, about 9.98 blocks/second or 599 blocks/minute. Phase 1 defaults therefore use 1,000 blocks per 60-second discovery tick, bounded to 2,000, with at most four concurrent log requests.

## Full gates

After the final Phase 1 source and test changes, the following gates passed on 2026-08-31:

```sh
pnpm lint
pnpm verify
git diff --check
```

- The isolated staged snapshot passed `pnpm lint`; Biome checked 257 files.
- The isolated staged snapshot passed `pnpm verify`; CLI 577/577, GUI 177/177, and all skills validation/tests passed.
- `git diff --check` passed.

The full gate must be rerun after any further source or documentation change. The Phase 0 evidence remains at `docs/robinhood-chain-phase0-evidence.md`.

## Acceptance boundary

Verified: TypeScript build, focused behavior, real read-only Chain 4663 log discovery in a temporary configuration directory, isolated SQLite persistence, no-delivery boundary, and documentation updates.

The initial isolated field sample observed 103 pools, 2,308 swap events across 21 active pools, and 33 audited
candidates. All candidates were rejected: all 33 had volume below the configured minimum and unknown liquidity;
32 also had low price coverage. Only four swaps were priced. This is evidence of the current coverage, not a
reason to lower hard gates. The corrected V3 deployment requires the one-time stablecoin-pool bootstrap plus fresh
bounded swap observations before its contribution can be assessed. This recovery mechanism does not lower
liquidity, volume, trader, price coverage, or score gates.

After the corrected factory and one-time bootstrap were loaded into the isolated sidecar, the database contained
30 Uniswap V3 pools. The first bounded post-bootstrap sample recorded 3 V3 swaps, including 1 priced swap and 1
event with non-null stablecoin-balance liquidity. This proves the V3 discovery, pricing, and liquidity paths are
active; it does not prove that market activity will satisfy the existing alert gates.

Not verified: completion of the 72-hour shadow operation, RPC provider rate limits, all venue decoders, live X
account login/challenge behavior, complete live reorgs, Windows/field acceptance, or any trading action.

Live Telegram delivery and LLM explanation require a separate approval after at least 72 hours of shadow evidence. Automatic trading remains out of scope.
