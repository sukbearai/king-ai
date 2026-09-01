# SPEC - Robinhood Chain X 默认采集与 RPC 限流恢复

- Tier: 3
- Artifact path: `docs/robinhood-chain-x-rpc-reliability-spec.md`
- Source scope: `packages/cli/src/trade/robinhood-chain-phase1.ts`, `packages/cli/src/trade/robinhood-shadow-daemon.ts`, `packages/cli/src/trade/scheduler.ts`, Robinhood trade configuration and English/Chinese trade documentation
- Isolation: existing worktree; preserve the unrelated watchdog edits already present in the worktree

## Setup Plan

- Tools or dependencies to add: none; use the existing `fetch`, scheduler, SQLite, and Node test runner
- Persistent files to add or change: the source, focused tests, `packages/cli/trade_config.example.json`, and the aligned `apps/docs/` trade pages; the live shadow config is updated only after code verification
- Environment changes: restart only the existing `dev.king-ai-robinhood-shadow` LaunchAgent after the verified build; do not restart or reconfigure `dev.king-ai-trade`
- Git operations proposed: none in this SPEC; commit/push remains separately authorized
- External or destructive actions proposed: no Telegram, LLM, wallet, signature, order, trade, or database deletion; a read-only live RPC probe and one shadow sidecar restart are allowed after local verification

## Scenarios

Feature: enable Robinhood ecosystem X collection by default and reduce Phase 1 RPC source errors without masking failures.

Scenario: default X collection is scheduled by the shadow daemon
  Given Phase 0, Phase 1, and Phase 2 are enabled and `x_enabled` is omitted
  When the shadow daemon runs a due cycle
  Then it runs Phase 0, Phase 1, and Phase 2 in order, independently starts at most one due X account collector, persists account observations, and keeps X activity out of chain trend scoring

Scenario: explicit X opt-out remains available
  Given `phase1.x_enabled=false`
  When the shadow daemon runs a cycle
  Then no X account request is made and the chain phases continue

Scenario: rate-limited log requests recover with bounded work
  Given an RPC transport returns HTTP 429 for the first log request and succeeds for a smaller block range
  When Phase 1 collects a bounded tick
  Then it retries with endpoint rotation/backoff and bounded log-range chunks, persists the batch, and records `source_health=ok`

Scenario: all RPC endpoints remain unavailable
  Given every endpoint returns a rate-limit, access, timeout, or server failure
  When Phase 1 collects a tick
  Then it fails closed, records `source_health=error`, preserves the last successful cursor, and does not report a successful batch

## Must NOT

- X collection must not create, qualify, or deliver a chain alert.
- X collection must not block or delay the Phase 0 -> Phase 1 -> Phase 2 chain cycle.
- Retries must be bounded; no request may spin indefinitely or overlap a still-running collector tick.
- A 429/403/timeout recovery must not reset source-health history or advance the persisted cursor without a committed batch.
- Delivery remains `shadow`; no Telegram, LLM, wallet, signing, order, or trade path is enabled.
- The existing unrelated watchdog worktree edits must not be staged or overwritten.

## Failure Model (Tier 3)

| Failure mode | User or system impact | Falsifying layer |
| --- | --- | --- |
| X stage is omitted from the sidecar | social first-party context remains empty despite default opt-in | shadow-daemon integration test |
| X account scanning blocks the chain cycle | confirmed-block lag grows while social collection is running | deterministic daemon barrier test and field log/cursor inspection |
| Public RPC returns 429/403 under concurrent `eth_getLogs` load | Phase 1 error rate rises and Phase 2 becomes source-unhealthy | focused transport/retry test plus isolated real RPC probe |
| Retry loop is unbounded or overlaps ticks | daemon stalls or duplicates work | retry-bound and daemon in-flight tests |
| Partial log recovery advances the cursor | missing events become invisible to later runs | persistence/failure test |
| X rows are incorrectly treated as chain evidence | false trend alerts | X isolation test and existing Phase 2 tests |

## Planned Gauntlet

| Claim or risk | Layer | Command or scenario | What it cannot prove |
| --- | --- | --- | --- |
| Defaults and X scheduling are correct | focused unit/integration | `node --test packages/cli/dist/test/robinhood-chain-phase1.test.js packages/cli/dist/test/robinhood-shadow-daemon.test.js` | real X login/challenge behavior |
| RPC retry/chunking is bounded and truthful | focused unit/integration | Phase 1 fake transport tests for 429, endpoint rotation, chunking, and all-endpoint failure | provider quota policy outside the tested endpoints |
| Source compiles and docs stay aligned | repository checks | `pnpm lint` and `pnpm verify` | field uptime and provider availability after the run |
| Assembled sidecar uses the new behavior | real execution | build, update the isolated shadow config, restart the existing LaunchAgent, inspect logs and SQLite health | 72-hour readiness gate and live delivery approval |

## Revisions

- Initial revision: 2026-08-31; requested after observing `x_enabled=false` and repeated Phase 1 `eth_getLogs` HTTP 429/403 failures
- Approved: 2026-08-31; user replied `批准 SPEC`
- Calibration note: 2026-08-31; isolated real probes showed a 1,000-block tick split into 500-block requests with three concurrent workers completed in 64.5 seconds without RPC errors, while four-worker field operation repeatedly produced 429/403; this selects the bounded implementation parameters without changing the approved behavior
- Proposed Revision 2: 2026-08-31; field execution showed that serially scanning 15 X accounts blocks the chain cycle long enough for confirmed-block lag to grow. Keep Phase 0 -> Phase 1 -> Phase 2 sequential and schedule X as one independently owned, non-overlapping in-flight job with the dedicated `trade-robinhood-search` browser session. Shutdown stops new schedules and waits for the owned X job before releasing the daemon lock. This preserves X isolation while preventing social collection from delaying chain truth.
- Revision 2 approved: 2026-08-31; user replied `批准 Revision 2`.
- Revision 2 local evidence: 2026-08-31; 56 focused tests passed, including independent X cadence, single-flight non-overlap, Phase 2 completion before a blocked X collector, X failure isolation, and PID-lock release only after X drain. `pnpm lint`, `pnpm verify`, and `git diff --check` passed.
- Revision 2 field evidence: 2026-08-31; isolated revision `phase2-v6-independent-x` started as PID `44431`. Its first cycle logged Phase 0 -> Phase 1 -> Phase 2 before X completion; Phase 0 advanced again while the 15-account X pass was still running, then X persisted 70 posts with `health={"ok":15}` and Phase 1 advanced again. Phase 1 source health was `ok`, `consecutive_failures=0`, and the v6 Phase 2 run persisted with `status=ok`. The unrelated trade daemon remained PID `97500`, and delivery stayed shadow-only with no Telegram or LLM configuration.
- Proposed Revision 3: 2026-08-31; follow-up diagnosis found three remaining repair targets: Phase 0 can burst 16 concurrent block RPCs and record 429/fetch failures; Phase 1 retries `eth_getLogs` but not timestamp, validation, and liquidity reads consistently; and swap logs are requested for all 1,156 discovered pools even though only 229 currently contain USDG/USDe and non-stable pools cannot produce a priced trend candidate. The revision will add bounded retry/endpoint rotation to every read RPC path, lower the isolated Phase 0 concurrency to a provider-safe value, restrict Phase 1 swap polling to stablecoin-eligible pools while retaining full pool discovery and audit semantics, and add focused failure/throughput tests. X `unknown` remains a truthful per-account health state; no unproven browser workaround will be added.
- Revision 3 approved: 2026-08-31; user replied `批准 Revision 3`.
- Revision 3 local evidence: 2026-08-31; the 54 affected Phase 0/Phase 1 tests passed, including retry coverage for every read RPC path, cursor preservation on failure, the default Phase 0 concurrency of three, and stablecoin-eligible swap polling while retaining complete pool discovery. `pnpm lint` passed. A fresh second `pnpm verify` passed after one unrelated CLI cwd test was rerun and confirmed transient; `git diff --check` passed in the same final command. Field evidence remains pending below.
- Revision 3 final local evidence: 2026-08-31; after the field configuration and documentation edits, `pnpm lint` passed, the 42 focused Phase 0/Phase 1/shadow-daemon tests passed, and `pnpm verify` passed with CLI 592/592, GUI worker 177/177, skill Node tests 11/11, skill Python tests 9/9, and 12 skills validated. `git diff --check` passed.
- Revision 3 field evidence: 2026-08-31; the isolated LaunchAgent restarted from PID `44431` to PID `72297`, while the unrelated trade daemon remained PID `97500`. Under revision `phase2-v7-rpc-throughput`, Phase 0 and Phase 1 both remained `status=ok` with `consecutive_failures=0`; Phase 2 persisted two `status=ok` runs and readiness remained `collecting` with `liveDeliveryAuthorized=false`. X completed independently with `health={"ok":15}` and later `health={"ok":10,"unknown":5}`, without blocking or creating chain evidence. Complete pool discovery grew to 1,330 pools, of which 250 were stablecoin-eligible at inspection time.
- Revision 3 throughput boundary: three consecutive Phase 1 successes advanced the cursor by 980 blocks each, but their target blocks advanced by 2,797, 3,049, and 2,393 respectively, so lag increased from 53,851 to 59,150. Phase 1 processing after Phase 0 fell to approximately 26-29 seconds in the later rounds, confirming the stable-pool restriction worked; the remaining bottleneck is Phase 0, whose later 1,980-block batches took approximately four to five minutes and increased lag from 8,404 to 9,811. Revision 3 therefore closes the observed RPC error-rate and Phase 1 scanning defects, but does not close backlog convergence or the 72-hour readiness gate.
- Proposed Revision 4: 2026-08-31; replace Phase 0's one-HTTP-request-per-block production path with bounded JSON-RPC batches while preserving exact response-id matching, block-number and parent-hash continuity validation, endpoint rotation, bounded retry, and all-or-nothing cursor persistence. Keep the Phase 0 -> Phase 1 -> Phase 2 ordering so total provider pressure remains bounded; no delivery or trading capability changes. A read-only field probe confirmed both configured RPCs accept 20-block batches, and the primary accepted a 50-block batch, so the implementation will start with a conservative bounded batch size and concurrency covered by focused payload, partial-response, duplicate-id, retry, and cursor-preservation tests. Field acceptance requires Phase 0 and Phase 1 lag to decrease across at least three consecutive successful rounds.

## Revision 4 approval gate

Approval is required before changing the Phase 0 transport contract or implementation. The revision adds no dependency, enables no delivery, and does not touch the original trade daemon. It authorizes source, tests, aligned English/Chinese documentation, a new isolated field revision, one shadow-sidecar restart after the local gauntlet, and read-only RPC/SQLite/log inspection.

- Revision 4 approved: 2026-09-01; user replied `继续修复` after the Revision 4 proposal and approval gate were presented.
- Revision 4 compatibility: `rpc_batch_size` becomes the Phase 0 request bound with a default of 50 and a maximum of 100. New readers ignore the obsolete `rpc_concurrency`; old readers ignore `rpc_batch_size` and fall back to their existing concurrency default, so rollback remains functional but returns to the slower per-block transport. No persisted SQLite representation changes.
- Revision 4 local evidence: 2026-09-01; the new Phase 0 batch tests passed together with the existing suite, `pnpm lint` passed, and the final fresh `pnpm verify` passed with CLI 596/596, GUI worker 177/177, skill Node 11/11, skill Python 9/9, and 12 skills validated. `git diff --check` passed before field rollout.
- Revision 4 field evidence: 2026-09-01; the shadow sidecar restarted from PID `72297` to PID `36290`, while the original trade daemon stayed PID `97500`. Revision `phase2-v8-phase0-batch` produced successful Phase 0/Phase 1/Phase 2 cycles; Phase 0 lag decreased `236,787 -> 236,022 -> 235,376 -> 234,795` with zero consecutive failures. Phase 1 lag remained non-convergent (`433,262 -> 433,488 -> 434,302`) because each successful tick advanced only 980 blocks while the target grew faster. Phase 2 remained `ok` with readiness `collecting` and live delivery disabled; X remained independent.
- Revision 4 extended field evidence: 2026-09-01; after the v8 restart, Phase 0 lag continued down `236,787 -> 236,022 -> 235,376 -> 234,795 -> 232,797 -> 232,067`, but Phase 1 hit another bounded failure (`eth_getLogs` 429/403, `consecutive_failures=1`) before recovering. The latest successful Phase 1 sample had lag `435,231`, so the overall convergence gate remains unmet.
- Proposed Revision 5: 2026-09-01; raise the Phase 1 catch-up capacity through an explicit bounded `max_log_blocks_per_tick`/schedule policy, preserving the 1,000-block steady-state safety bound as the normal mode and using a separately tested catch-up mode only while lag exceeds a threshold. The change must retain bounded log request size, concurrency, retry/rotation, full pool discovery, stable-only swap polling, atomic cursor advancement, and shadow-only delivery. Field acceptance requires Phase 1 lag to decline across three consecutive successful cycles without renewed 429/403 errors.

- Revision 5 approved: 2026-09-01; user replied `批准 Revision 5`.
- Revision 5 implementation contract: steady-state `max_log_blocks_per_tick` remains capped at 1,000; catch-up activates only when persisted-cursor lag exceeds `catch_up_lag_blocks` (default 10,000) and is capped by `catch_up_blocks_per_tick` (default and maximum 2,000). A bounded `provider_cooldown_ms` (default 5,000, maximum 30,000) separates due Phase 0 and Phase 1 stages and is interruptible during daemon shutdown. Existing configurations remain readable, no SQLite schema changes, and rollback ignores the additive fields and returns to the Revision 4 schedule.
- Revision 5 throughput refinement: field calibration showed that increasing each log range to 1,000 blocks reduced request count but increased provider latency enough for lag to grow. The current-range creation scan therefore keeps the proven bounded log chunking and combines all five enabled protocol address/topic pairs into one OR filter per chunk, then rejects any returned log that does not map back to an enabled protocol pair. This removes 16 repeated creation-log requests from a 2,000-block/500-block-chunk catch-up tick without reducing pool discovery coverage or changing swap filters.
- Revision 5 provider-isolation refinement: repeated 429/403 failures persisted after the maximum 30-second inter-stage cooldown because Phase 0 and Phase 1 still shared the same ordered endpoint list. Additive `phase1.rpc_urls` lets Phase 1 use a dedicated ordered list while absent or empty values inherit the parent list. The isolated field config assigns publicnode to Phase 0 block batches and the Robinhood main RPC to Phase 1 logs; no persisted format or delivery capability changes.
- Revision 5 swap-query refinement: provider isolation proved that the main RPC still rejected Phase 1's own burst. Combine non-V4 stablecoin pools across protocols into bounded groups of at most 50 execution addresses with an OR list of their verified swap topics, then fail closed unless every returned address/topic pair maps to the requested pool's protocol. V4 retains its existing pool-key topic filter. Non-stable pools remain excluded and cursor atomicity is unchanged.

## Revision 5 approval gate

Approval is required before changing Phase 1 catch-up limits or scheduling semantics. The revision adds no dependency and no delivery capability, keeps X independent, and does not touch the original trade daemon. It authorizes source/tests/docs changes, a new isolated shadow revision, one sidecar restart after local verification, and read-only RPC/SQLite/log inspection.

## Revision 3 approval gate

Approval requested before implementation. The revision does not change delivery mode, add dependencies, delete persisted data, or touch the original trade daemon. It authorizes only source/test/docs changes, a new isolated shadow config revision, and restart of `dev.king-ai-robinhood-shadow` after the final local gauntlet. The live Phase 1 cursor remains monotonic and is never advanced from a partial or failed batch.

- Revision 5 final field result: 2026-09-01; the final request-compressed revision produced four consecutive successful Phase 1 batches without a new 429/403 at the observed process boundary, advancing the cursor `50,863,851 -> 50,865,831 -> 50,867,811 -> 50,869,791 -> 50,871,771`. The corresponding lag sequence included `462,638 -> 463,212 -> 462,918 -> 463,985`, so it did not decline for three consecutive successful cycles. The latest readiness check remained `collecting`, with `sourceErrorRate=0.4167` over the full `phase2-v9-phase1-catchup` evidence epoch and `liveDeliveryAuthorized=false`. Revision 5 therefore improves the short-window provider error rate but fails its backlog-convergence acceptance criterion.
- Revision 5 scheduling boundary: successful Phase 1 completions were separated by approximately four minutes because the daemon still waits for Phase 0 and the provider cooldown before starting Phase 1. A 2,000-block catch-up budget advances the persisted cursor by 1,980 net blocks after the 20-block reorg overlap, while the confirmed target can grow by more than that during the serialized cycle. Raising the catch-up limit beyond the approved 2,000 maximum or changing stage ownership is outside Revision 5.
- Proposed Revision 6: when the resolved Phase 0 and Phase 1 RPC endpoint sets are disjoint, run the due Phase 0 and Phase 1 collectors concurrently under one daemon-owned cycle, keep each stage single-flight, await both results before Phase 2, and drain in-flight chain work before releasing the daemon lock. When the endpoint sets overlap, retain the Revision 5 sequential Phase 0 -> interruptible cooldown -> Phase 1 behavior so an inherited or shared public provider is never exposed to new cross-stage concurrency. X remains an independently owned single-flight collector and remains excluded from chain scoring. No collector cursor, SQLite schema, delivery mode, retry bound, request range, or catch-up limit changes.

## Revision 6 approval gate

Approval is required before changing Phase 0/Phase 1 scheduling ownership. The revision adds no dependency or delivery capability, preserves the 2,000-block Phase 1 catch-up maximum, and does not touch the original trade daemon. It authorizes source/tests/aligned English and Chinese documentation changes, a new isolated field revision, one shadow-sidecar restart after the final local gauntlet, and read-only RPC/SQLite/log inspection. Field acceptance requires Phase 0 and Phase 1 lag to decline across at least three consecutive successful cycles without renewed 429/403 errors; the separate 72-hour Phase 2 readiness and human review gates remain unchanged.

- Revision 6 approved: 2026-09-01; user replied `批准 Revision 6`.
- Revision 6 implementation detail: endpoint overlap is compared through the existing sanitized RPC representation, which removes credentials, query parameters, fragments, and trailing slashes. This intentionally treats credential or API-key variants of the same base URL as shared-provider configuration and keeps the sequential cooldown path. Invalid URLs also fail conservatively into the shared set rather than enabling concurrency.
- Revision 6 field result: 2026-09-01; the isolated shadow sidecar restarted from PID `76335` to PID `48861`, while the original trade daemon remained PID `97500`. The v10 logs repeatedly recorded `chain stages parallel rpcSets=disjoint`; Phase 2 ran only after both chain stages settled. No new 429/403 was observed. After the first warm-up sample, Phase 0 lag declined `212,994 -> 212,873 -> 212,008 -> 211,421`, and Phase 1 lag declined `465,988 -> 465,264 -> 465,131 -> 464,268 -> 463,681`, with both source failure counters at zero. Revision 6 therefore passes its short-window backlog-convergence acceptance criterion. Phase 2 remains a separate `collecting` gate with `liveDeliveryAuthorized=false`.
- Proposed Revision 7: split Phase 0 and Phase 1 into realtime and historical-backfill lanes under each collector's existing single-writer ownership. The first successful realtime batch starts near the confirmed tip and persists `realtime_cursor` plus `realtime_start_block`. The existing `last_confirmed_block` is preserved as the rollback-safe historical cursor and mirrored to `backfill_cursor`; a fresh database initializes that cursor immediately before the realtime coverage start. Realtime work runs first on every due collector tick. Historical work continues toward the fixed `realtime_start_block - 1` boundary on its own bounded cadence, so the historical gap can close without chasing a moving chain tip. Both lanes retain bounded ranges, reorg overlap, retry/rotation, exact response validation, idempotent event keys, and transactionally coupled cursor advancement.
- Revision 7 freshness contract: the existing `robinhood_chain` and `robinhood_chain_phase1` health rows become realtime authority. Backfill writes separate health rows and cannot make a successful realtime source unhealthy. Phase 1 adds an additive `collection_lane` audit field; Phase 2 counts and materializes only `realtime` audit rows. Backfill may recompute historical windows but cannot create a realtime shadow draft, including when the delayed window still falls inside Phase 2's configured lookback. `history_complete` becomes true only when the contiguous backfill cursor reaches the fixed realtime coverage boundary. Realtime readiness and historical completeness remain separately reported.
- Revision 7 lifecycle and compatibility: RPC reads for the two lanes are sequential within one collector call and all SQLite writes remain owned by that collector's single connection/transaction path. A realtime failure fails closed, leaves both cursors unchanged for that lane, and prevents backfill from taking priority. A backfill failure records bounded backfill health without cancelling an already committed realtime batch. Shutdown retains the Revision 6 outer-cycle drain. The migration is additive: no existing event, block, audit, review, or readiness row is deleted; no dependency is added; rollback ignores the new keys/column and resumes the old single cursor from `last_confirmed_block` without skipping the historical gap.

## Revision 7 scenarios

Scenario: migrate an existing historical cursor without losing coverage
  Given `last_confirmed_block` is far behind the confirmed tip and no lane state exists
  When the first Revision 7 realtime batch succeeds
  Then realtime coverage starts near the confirmed tip, `last_confirmed_block` remains the historical cursor, and the gap between that cursor and `realtime_start_block` remains explicitly incomplete

Scenario: keep current trends fresh while historical backfill advances
  Given realtime coverage has started and a historical gap remains
  When a due collector tick succeeds
  Then realtime advances first, backfill advances only on its bounded cadence toward the fixed coverage boundary, and the two health/lag values remain independently observable

Scenario: reject late historical alerts
  Given a backfill batch recomputes a qualified window inside the Phase 2 lookback
  When Phase 2 reads Phase 1
  Then the historical audit is retained but no shadow draft is materialized from it

Scenario: preserve realtime success when backfill fails
  Given a realtime batch committed and the following backfill RPC exhausts its bounded retries
  When the collector returns
  Then realtime health and cursor stay successful, backfill health records the failure, and no cursor advances for the failed backfill range

Scenario: close the historical gap exactly once
  Given backfill reaches or overlaps `realtime_start_block - 1`
  When the final bounded batch commits
  Then its end is capped at that boundary, `history_complete=1`, and later ticks do not rescan or emit alerts for the closed historical lane

## Revision 7 Must NOT

- Must not jump or replace `last_confirmed_block` with the realtime cursor while a historical gap exists.
- Must not let backfill health or late candidates masquerade as realtime source freshness.
- Must not run multiple SQLite writers or let cursor state commit separately from the corresponding block/event batch.
- Must not increase the existing 2,000-block hard range limits, enable delivery, or change wallet/trading capability.
- Must not modify an existing live SQLite database or restart a daemon without a separate target-specific authorization checkpoint after local verification.

## Revision 7 failure model

| Failure mode | Impact | Falsifying evidence |
| --- | --- | --- |
| Legacy cursor is replaced by tip | permanent historical gap after rollback | migration and rollback compatibility tests |
| Realtime and backfill overlap ownership | duplicate/replaced audit provenance or inconsistent windows | boundary, idempotency, and final-gap tests |
| Backfill candidate reaches Phase 2 | delayed event is presented as current alpha | Phase 1/Phase 2 integration test |
| Backfill failure poisons realtime health | current source appears unavailable despite fresh committed data | independent health failure test |
| Crash or RPC partial response advances a lane cursor | missing blocks/logs become invisible | failure-before-commit tests for both lanes |
| Backfill cadence starves realtime or shutdown | latest trends lag or daemon lock leaks | deterministic ordering and drain tests |

## Revision 7 planned gauntlet

| Claim | Layer | Planned evidence | Boundary |
| --- | --- | --- | --- |
| Cursor migration, coverage closure, and lane failure isolation | focused SQLite/module integration | compiled Phase 0 and Phase 1 tests with disposable databases and fake RPC | does not prove public-provider capacity |
| Phase 2 consumes realtime provenance only | Phase 1/Phase 2 integration | compiled Phase 2 tests using additive lane-aware fixtures | does not prove alert quality |
| Lifecycle remains single-flight and drained | daemon integration | compiled shadow-daemon ordering/shutdown tests | does not prove OS LaunchAgent behavior |
| Repository assembly remains valid | static/full suite | `pnpm lint`, focused compiled tests, `pnpm verify`, decision validator, `git diff --check` | does not prove deployed migration or field convergence |
| Existing database migration and live lag behavior | isolated field execution | separately authorized backup/preflight, sidecar restart, SQLite/log observation | does not authorize live delivery |

## Revision 7 approval

- Revision 7 approved: 2026-09-01; after the dual-lane proposal and closure boundaries were presented, the user replied `批准`.
- Approval authorizes source, tests, SPEC/decision records, aligned English/Chinese documentation, and local disposable-database verification. It does not authorize writing the existing shadow SQLite files, changing the field configuration, restarting either daemon, commit, push, deployment, paid RPC use, or live delivery. Those remain separate checkpoints.
- Revision 7 implementation refinement: a prolonged stop can put `realtime_cursor` farther behind the tip than one bounded realtime batch. In that case the collector must not spend multiple ticks catching up before restoring freshness. It starts a new bounded tip window, advances `realtime_start_block` to that window, resets `history_complete=0`, and reopens backfill from the last contiguous rollback-safe `last_confirmed_block` to the new fixed boundary. Tests cover this restart gap for both Phase 0 and Phase 1. This preserves the approved realtime-first behavior without jumping or discarding historical coverage.

## Revision 7 field result

- Target-specific field authorization was received on 2026-09-01 after the backup, schema, config, restart, acceptance, and rollback boundary was presented. Only the isolated shadow SQLite files, shadow config, and `dev.king-ai-robinhood-shadow` restart were authorized; the original trade daemon, live delivery, wallet, signing, order, trade, commit, and push boundaries remained excluded.
- The sidecar was unloaded from PID `48861`; it did not finish within the initial 60-second drain wait, but exited before any write. With the LaunchAgent unloaded, no SQLite handles remaining, the original trade daemon still PID `97500`, and all three `quick_check` results `ok`, a consistent backup was created and reconciled before migration.
- The additive Phase 1 migration added `signal_audit.collection_lane TEXT NOT NULL DEFAULT 'legacy'`. All 4,868 existing audit rows remained present and became `legacy`; no core Phase 1 table count changed. The config added 300-second Phase 0/Phase 1 backfill cadences and opened `phase2-v11-dual-lane`. The new shadow sidecar started as PID `57946`; the original trade daemon remained PID `97500`.
- Realtime freshness and isolation passed in the observed window. Phase 0 and Phase 1 both reached confirmed-tip lag 0, backfill health rows remained independent, Phase 1 produced `realtime` and `backfill` provenance, Phase 2 recorded a v11 `ok` run using realtime audits only, no duplicate shadow-alert pool/window/revision group existed, and the post-restart boundary contained no 429, 403, or Phase 0/1 failure.
- Historical closure failed. The first Phase 1 backfill advanced 1,980 net blocks and reported gap 474,970. Because Phase 1 realtime processing itself took longer than the 1,000-block realtime capacity, the next ordinary in-process cycle was classified as a tip jump and advanced `realtime_start_block`; the observed Phase 1 gap later reached 480,962 despite another 1,980-block backfill advance. Phase 0 also rebased its coverage boundary, although its observed gap remained smaller. Revision 7 therefore restores current trend visibility but does not close the historical backlog under the field workload.
- Decision status remains `proposed`; `phase2-v11-dual-lane` remains `collecting` with `liveDeliveryAuthorized=false`. The 72-hour and manual-review gates have not started from a qualifying closed implementation.

## Proposed Revision 8

Revision 8 separates a true process-start recovery from ordinary in-process capacity pressure and reduces the Phase 1 realtime RPC request surface:

- only the first collector attempt in a new shadow-daemon process may rebase realtime coverage to the confirmed tip; later cycles must not silently move `realtime_start_block` when they exceed the bounded window;
- an in-process capacity overrun must be observable and fail the freshness gate instead of expanding the historical target;
- Phase 1 realtime must query the verified V4 PoolManager once per bounded block chunk by swap topic, then retain only logs whose pool key belongs to the known stablecoin pool set. This replaces the current roughly ten V4 stable-pool topic groups for 964 observed V4 stable pools while preserving address/topic validation, pool membership validation, event idempotency, and non-stable exclusion;
- non-V4 bounded address groups, backfill ordering, the 2,000-block backfill maximum, single-writer SQLite ownership, `collection_lane`, Phase 2 realtime-only consumption, X independence, and shadow-only delivery remain unchanged.

Revision 8 RED must reproduce an ordinary slow second cycle that moves `realtime_start_block` and increases the Phase 1 gap. GREEN requires a same-process slow-cycle test that cannot rebase, a fresh-process recovery test that can rebase once, V4 mixed stable/non-stable response validation tests, and a provider-pressure test that preserves cursor atomicity. Field acceptance requires at least three consecutive realtime completions within the freshness threshold, a stable `realtime_start_block` during the same process, monotonically decreasing Phase 0 and Phase 1 backfill gaps across two due backfill cycles, and no 429/403, duplicate audits, or duplicate drafts.

## Revision 8 approval

- Revision 8 approved: 2026-09-01; after the process-attempt rebase ownership, V4 topic-only scan, failure behavior, preserved invariants, and acceptance boundaries were presented, the user replied `批准 Revision 8`.
- Approval authorizes source, tests, SPEC/decision records, aligned English/Chinese documentation, and local disposable-database verification. It does not authorize modifying the existing shadow configuration or SQLite files, restarting shadow PID `57946`, touching the formal trade daemon PID `97500`, commit, push, deployment, live delivery, wallet access, signing, orders, or trading.
- Revision 8 implementation refinement: the same first-attempt ownership is applied to both long-lived owners, `runRobinhoodShadowDaemon` and the ordinary trade scheduler. Otherwise a collector invoked by the ordinary daemon would retain the same repeated-rebase defect even though its standalone default remains suitable for manual one-shot recovery. This does not change either daemon's cadence, process ownership, delivery capability, or persisted format.
- Revision 8 field clarification: the first topic-only field response contained valid V4 pool keys that were not present in the local registry. The approved rule is literal set retention: valid logs outside the known stablecoin pool set, including known non-stable and valid unknown keys, are filtered. Wrong PoolManager/topic, malformed pool keys, and registered pools with conflicting protocol or execution identity still fail the entire batch before cursor advancement.

## Revision 8 field result

- Target-specific authorization for the field build, isolated shadow-sidecar restart, and historical-backlog convergence observation was received on 2026-09-01. The formal trade daemon, live delivery, wallet, signing, orders, trading, commit, and push remained outside the authorization.
- The corrected build started the isolated LaunchAgent as PID `20404` with field revision `phase2-v12-fixed-rebase-v4-topic`; the formal trade daemon remained PID `97500`. The first process attempt was allowed to recover realtime coverage once. Phase 0 then persisted realtime `51,453,440` and backfill `51,219,073/51,451,440`; Phase 1 persisted realtime `51,453,522` and backfill `50,947,011/51,452,522`.
- The next same-process attempt correctly kept `realtime_start_block` fixed at `51,451,441` for Phase 0 and `51,452,523` for Phase 1, but failed closed before cursor or coverage writes because the confirmed tip had advanced beyond the bounded capacities: Phase 0 reported `cursor=51453440 target=51456656 capacity=2000`, and Phase 1 reported `cursor=51453522 target=51456654 capacity=1000`. Later retries remained fixed and failed for the same capacity reason.
- Therefore Revision 8 passes the no-repeat-rebase and atomic-failure requirements but fails field acceptance: it did not produce three consecutive realtime completions or two decreasing backfill-gap samples. The single successful cycle took long enough that the outer single-flight cycle delayed both realtime lanes beyond their next bounded windows. Any timestamp batching, lane decoupling, scheduling change, or capacity-policy change requires a new approved SPEC revision.

## Proposed Revision 9

Revision 9 replaces full-chain RPC discovery with GMGN as the primary read-only Robinhood trend source. Robinhood RPC remains available only for bounded verification of addresses already shortlisted by GMGN. The previously proposed timestamp-batching change is withdrawn from this revision because improving the old scanner does not remove its field-proven backlog and cadence coupling.

### Source and credential contract

- Production uses a repository-owned HTTP adapter built on the existing `fetch`; it pins the GMGN origin to `https://openapi.gmgn.ai`, does not allow a runtime base-URL override, does not shell out to a mutable globally installed `gmgn-cli`, and adds no dependency.
- The adapter reads only `GMGN_API_KEY` from the environment. It must not read, copy, log, persist, inherit into a child process, or require `GMGN_PRIVATE_KEY`, wallet material, signing capability, swap routes, order routes, cooking routes, portfolio routes, or any other write-capable GMGN surface.
- The first required feeds are the proven read-only endpoints: `GET /v1/market/rank` for `chain=robinhood` and intervals `1m`, `5m`, and `1h`; and `POST /v1/trenches?chain=robinhood` for `new_creation`, `near_completion`, and `completed`. `token_signal` is excluded until its request and response contract is independently proven.
- Each due Phase 1 collection performs at most the three trending requests and one trenches request. The configured requested limit defaults to 100 and is capped at 200, and the collector enforces the same cap after parsing because the live trenches endpoint has returned more rows than requested.

### Clock and request lifecycle

- GMGN's authenticated timestamp is derived from the GMGN HTTPS response `Date` header, using the request midpoint to calculate an in-memory offset. The collector never changes the OS clock and never persists the offset as authority.
- Clock synchronization fails closed when the `Date` header is absent or invalid, round-trip time exceeds 10 seconds, or the absolute calculated offset exceeds 10 minutes. A valid offset is refreshed at least every 10 minutes.
- Each request uses a fresh UUID `client_id` and the adjusted timestamp. `AUTH_TIMESTAMP_EXPIRED` permits exactly one forced clock refresh and one replay. Other 401/403 responses are not retried. HTTP 429 honors `Retry-After` only when it is valid and no greater than 5 seconds; transport, 429, and 5xx failures have at most three total attempts within a 15-second request deadline. No retry may overlap the next collector tick.
- Authentication headers, API keys, raw response bodies, and query signatures are never written to logs, SQLite, status output, tests, or EVIDENCE. Diagnostics contain only endpoint kind, HTTP/error category, attempt count, and redacted timing.

### Schema, normalization, and identity

- A token identity is an exact 20-byte EVM address. Input accepts only `0x` plus 40 hexadecimal characters and persists the lowercase form; malformed addresses reject that record.
- Trending parsing accepts the observed nested envelope only when the outer response and the nested `code` are successful and `data.rank` is an array. Trenches parsing requires an object whose requested categories are arrays. A malformed required envelope rejects the whole endpoint batch before observations or health success advance.
- Required provenance is `source=gmgn`, endpoint kind, trending interval or trenches category, token address, upstream observation time from the HTTP `Date`, local ingestion time, and freshness. Financial/count fields accept finite non-negative numeric strings or numbers. Missing or invalid fields remain `null`/unknown and never silently become zero for qualification.
- The first normalized fields are address, optional pool address, symbol, price, interval volume or `volume_24h`, swaps or `swaps_24h`, liquidity, market cap, holder count, creation/open timestamps, launchpad metadata, smart-degen and renowned counts, honeypot and wash-trading flags, holder/insider/bundler/sniper/bot/fresh-wallet concentration fields, and social links/duplication flags when present.
- A deterministic observation key is `gmgn:<feed>:<interval-or-category>:<address>:<observation-window>`. Trending windows use their declared interval; trenches uses a one-minute observation window. Polling the same key updates one observation. A token seen in multiple feeds retains every provenance row and merges into one candidate snapshot; one feed must not overwrite or impersonate another.

### Candidate and Phase 2 contract

- GMGN observations are stored in the new resolved state path `trade/state/robinhood_chain_gmgn.sqlite`, separately from the legacy RPC pool/event/audit tables. Schema version `gmgn-v1` owns `gmgn_observations` (deterministic observation key and normalized/provenance payload), `gmgn_candidates` (token/window identity, state, score, reasons, evidence, update time), and `source_health` (GMGN status, upstream observation time, last success, consecutive failures, and redacted error category). Observation/candidate/health writes for one tick share one SQLite transaction.
- A source-agnostic candidate DTO identifies `subject_type=token`, `subject_address`, optional `pool_address`, observation window, score, reasons, and full feed provenance. Phase 2 adds authoritative `subject_type`, `subject_address`, optional `pool_address`, and `source_kind` columns to its shadow ledger. Existing pool-oriented columns remain for legacy rows; a v13 GMGN row fills the compatibility `pool_key` with the verified pool address when present or otherwise the token address, but uniqueness, review, X matching, and message rendering use the new subject fields. Existing RPC rows and SQLite databases remain readable for audit and rollback but are not reinterpreted as GMGN observations.
- A GMGN token can become a shadow candidate only when a fresh `5m` trending observation is corroborated in the same five-minute window by either `1m` trending or one trenches category; `1h` alone cannot qualify. The `5m` record must have known volume, liquidity, swaps, and holder count, meet the existing `min_volume_5m_usd` and `min_liquidity_usd` thresholds, have swaps and holders greater than zero, and explicitly report both `is_honeypot=false` and `is_wash_trading=false`. Missing risk or required market fields fail closed.
- The deterministic evidence score is 50 for a qualifying `5m` observation, plus 20 for `1m` corroboration, plus 15 for `new_creation` or `near_completion` corroboration or 10 for `completed`, plus 5 each when `smart_degen_count>0` and `renowned_count>0`, capped at 100. This score measures evidence strength only and is not a return forecast. Existing `min_trend_score` remains the final threshold; `min_unique_traders` is not applied because GMGN swaps, holders, and wallet-class counts are not equivalent to unique traders.
- Phase 2 uses a new epoch `phase2-v13-gmgn-primary`. Only successful GMGN batches and candidates from this epoch count toward readiness, source error rate, audits, drafts, or reviews. Old v12 runs, RPC backfill rows, and X-only evidence remain auditable but cannot satisfy the new gate. X remains optional enrichment and can attach only by exact token or pool address; it cannot create or qualify a candidate.

### RPC verification and legacy backlog

- Full-chain Phase 0/Phase 1 discovery and historical backfill are disabled in the GMGN shadow mode. Their existing databases, cursors, coverage markers, and health rows are retained without deletion or migration and are excluded from v13 readiness.
- RPC may verify only a bounded shortlist produced by the current GMGN batch: Chain ID `4663`, bytecode existence for contract addresses, and pool/contract identity when a pool address is present. Verification uses a hard maximum of 20 unique addresses per tick and the existing bounded endpoint retry/redaction rules.
- RPC verification cannot create a token, add missing GMGN provenance, turn an unqualified observation into a candidate, or substitute stale/unavailable GMGN discovery. A required RPC check that fails or disagrees marks the candidate unverified and prevents Phase 2 materialization for that window.
- “Historical backlog reaches zero” is retired as a launch gate for GMGN mode. It remains a truthful legacy metric only. No database, row, cursor, audit, or backup is deleted under Revision 9.

### Failure behavior, lifecycle, and rollback

- A collection tick is single-flight. Trending intervals may run in parallel, but the collector waits for all required responses plus trenches, validates them independently, then atomically commits accepted observations, merged candidates, and source health. A failed required feed makes the tick unhealthy and creates no new qualified candidate for that tick; previously persisted observations remain unchanged.
- Stale upstream time, schema drift, invalid address/numeric fields above the per-record boundary, timestamp failure after its one replay, auth denial, exhausted rate limit, or shutdown before commit fails closed. Shutdown stops new requests, aborts/drains the owned fetches within the existing daemon deadline, commits no partial tick, and releases no secret-bearing state.
- GMGN unavailability permits RPC verification of already persisted candidates only for diagnostics; it cannot discover, refresh, qualify, or materialize a new trend. Readiness records a source error.
- Rollback disables GMGN mode and returns to the existing RPC collector code and its untouched legacy databases. The v13 epoch remains in SQLite for audit but cannot be combined with a later RPC epoch. Rollback does not require a down-migration or deletion.

### RED, GREEN, and acceptance

Revision 9 RED must cover: nested trending envelope handling; trenches returning more than the requested limit; duplicate polls and cross-feed provenance merge; missing/invalid required fields; stale response time; 105-second local clock skew; missing or unreasonable server `Date`; one timestamp refresh/replay; non-timestamp 401/403; bounded 429 handling; API-key redaction; proof that `GMGN_PRIVATE_KEY` is never read or forwarded; RPC verification being unable to create a candidate; and Phase 2 rejecting v12/legacy RPC evidence.

GREEN requires focused parser, auth/clock, lifecycle, persistence, deduplication, candidate, RPC-verification, Phase 2 epoch, and daemon tests using recorded secret-free fixtures. The final local gauntlet is the focused compiled Robinhood suite, `pnpm lint`, `pnpm verify`, English/Chinese docs build, decision validation, secret/capability scan, and `git diff --check`.

Field rollout remains separately authorized. It requires an explicit minimal environment containing `GMGN_API_KEY` but not `GMGN_PRIVATE_KEY`, a new isolated shadow build and restart, and read-only log/SQLite observation. Acceptance requires at least three consecutive successful GMGN ticks, all six feed categories observed within their freshness limits, zero secret leakage, bounded 401/403/429 behavior, no duplicate observations/candidates/drafts, successful bounded RPC verification for materialized candidates, v13-only readiness accounting, and shadow-only delivery. The 72-hour, 800-run, review, and separate live-delivery approval gates remain unchanged.

## Revision 9 approval gate

Approval is required before implementation because this revision changes the primary producer, persisted observation contract, candidate semantics, readiness authority, and rollback boundary. Approval authorizes only the described source, tests, proposal/decision records, aligned English/Chinese documentation, and local disposable-database verification. It does not authorize changing the existing shadow configuration or SQLite files, restarting a daemon, commit, push, deployment, paid GMGN operations, live delivery, wallet access, signing, swaps, orders, or trading.

## Revision 9 approval

- Revision 9 approved: 2026-09-01; after the GMGN-primary source, server-date clock correction, credential boundary, independent persistence, source-agnostic candidate identity, bounded RPC verification, v13 readiness epoch, legacy-backlog retirement, failure behavior, rollback, and acceptance contract were presented, the user replied `批准 Revision 9`.
- Approval authorizes the described source, focused tests and disposable SQLite writes, configuration example, SPEC/EVIDENCE/decision records, aligned English/Chinese documentation, and local verification. It does not authorize changing or migrating any existing shadow database, reading or using `GMGN_PRIVATE_KEY`, changing the existing shadow configuration, restarting either daemon, commit, push, deployment, paid operations, live delivery, wallet access, signing, swaps, orders, or trading.
- Revision 9 local implementation clarification: the requested trenches limit is enforced independently for `new_creation`, `near_completion`, and `completed`, so an oversized first category cannot prevent the other required feeds from being observed. The daemon-owned abort signal also covers bounded RPC shortlist verification, preventing shutdown from entering another endpoint or retry after cancellation. Trending requires both observed success codes and exact Chain ID validation rejects malformed hexadecimal suffixes. These changes implement the already approved feed, fail-closed, and shutdown contracts without adding endpoints, credentials, delivery, or trading capability.
