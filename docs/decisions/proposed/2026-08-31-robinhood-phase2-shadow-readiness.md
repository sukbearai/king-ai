# Decision: Robinhood Phase 2 remains a shadow evidence gate

Status: proposed

## Problem

Phase 1 can identify deterministic chain trends, but source tests and a one-time RPC smoke do not establish that live alerts are reliable. The system needs a durable way to measure continuous collection, preserve draft evidence, and collect human false-positive reviews without accidentally enabling delivery.

## Proposal

Add Phase 2 as an isolated consumer of the Phase 1 SQLite database. Phase 2 writes only to `robinhood_chain_phase2.sqlite`, creates deterministic local alert drafts, stores append-only human review events, and calculates a strict readiness state.

Readiness is partitioned by a durable `field_run_revision`. Material source, decoder, threshold, or field
configuration changes start a new evidence epoch without deleting the old audit rows. Only runs, drafts, and
reviews from the current revision count toward its readiness gate.

`approval_required` means the automated and review evidence is ready for a separate decision. It always includes `liveDeliveryAuthorized=false`. Phase 2 has no Telegram or LLM dependency and cannot change the real trade configuration.

The durable owner of the detailed schema and thresholds is `docs/robinhood-chain-phase2-spec.md`.

## Alternatives considered

- Send low-severity Telegram alerts immediately: rejected because it bypasses the approved 72-hour shadow gate.
- Reuse the Phase 1 database for draft and review writes: rejected because it couples chain truth with presentation and human workflow state.
- Let X activity create drafts: rejected because social activity is not chain evidence and is easy to manipulate.
- Use an LLM to decide readiness: rejected because readiness metrics and gates must remain deterministic and auditable.

## Risks

- A public RPC or X source may be unavailable long enough that readiness never advances.
- Strict address matching intentionally misses narrative X posts without a full on-chain identifier.
- Local SQLite evidence is not field acceptance until the daemon actually runs for the required duration.
- Old Phase 2 drafts remain audit records after disablement and require separately authorized cleanup if deletion is desired.

## Verification

Required before changing this decision to implemented:

- focused source and SQLite tests for idempotency, stale transitions, readiness gates, and review history;
- CLI and daemon integration tests;
- repository lint/build/test gates;
- at least 72 hours of real shadow operation with the configured run count, gap, error-rate, audit, and review evidence;
- a separate human approval for any delivery mode other than `shadow`.

## Rollback

Set `data_sources.robinhood_chain.phase1.phase2.enabled=false` and restart the daemon. Phase 0 and Phase 1 continue unchanged. Retain the Phase 2 database for audit; deletion is not part of rollback.
