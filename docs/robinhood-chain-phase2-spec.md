# SPEC - Robinhood Chain Phase 2 Shadow Alert Readiness

Status: approved for local shadow implementation on 2026-08-31.

## Objective

Phase 2 converts Phase 1 deterministic candidates into bounded, reviewable shadow alert drafts and measures whether the collector has accumulated enough field evidence for a separate live-delivery decision.

Approval covers local SQLite materialization, readiness metrics, manual review records, CLI inspection, and opt-in daemon scheduling. It does not authorize Telegram delivery, LLM explanation, wallet access, signatures, orders, transaction broadcasting, or automatic trading.

## Input authority

Phase 1 remains the only producer of chain candidates. Phase 2 reads the isolated Phase 1 database and never rescans the chain or changes Phase 1 candidate scores.

Required Phase 1 inputs are:

- `trend_candidates`, including state, score, components, and immutable evidence JSON;
- `signal_audit`, including source block range, decoder version, and config revision;
- `pools`, for protocol and token identity;
- `source_health`, for current collector health and last successful collection;
- `account_posts`, only for exact address/pool-key matches that enrich an existing chain candidate.

X posts cannot create a draft, change a score, or satisfy a chain-data gate.

## Phase 2 output

Use a new `robinhood_chain_phase2.sqlite` database. Do not migrate or write to the Phase 1 database.

Persist:

- `phase2_runs`: every materialization attempt, source health, bounded input counts, and failure category;
- `shadow_alerts`: one idempotent draft per Phase 1 pool/window/config revision;
- `alert_reviews`: a local human verdict (`accepted` or `rejected`) and bounded note;
- `readiness_checks`: deterministic field-gate metrics and reason codes.

Every record carries a bounded `field_run_revision`. Readiness queries only the current configured revision. Older
revision rows remain available for audit, but their run duration, alert drafts, and human reviews cannot satisfy a
new revision's gate. A material collector, decoder, threshold, or field configuration change requires a new
revision before the daemon is restarted.

Drafts are local evidence records, not notifications. A Phase 1 candidate that becomes rejected/stale or a Phase 1 source that becomes unhealthy makes its active Phase 2 draft stale.

## Deterministic draft contract

Each draft contains:

- stable alert id, Phase 1 pool/window identity, protocol, token addresses, score, and strength tier;
- exact Phase 1 evidence and audit provenance;
- up to three X posts only when the text contains the full pool or token address;
- a deterministic neutral summary with no buy/sell instruction.

Strength tiers are presentation labels only:

- `strong`: score at least 80;
- `moderate`: score at least 65;
- `watch`: lower qualified score.

## Readiness gate

Defaults are intentionally strict and bounded:

- at least 72 hours between the first and latest Phase 2 run;
- at least 800 successful materialization runs;
- no run gap above 15 minutes;
- source-error rate no greater than 5%;
- Phase 1 source success no older than 10 minutes at materialization time;
- at least one audited Phase 1 window;
- at least 10 manually reviewed shadow alerts.

The output is `collecting`, `review_samples_required`, or `approval_required`. `approval_required` means the evidence gate passed and a human may consider a separate delivery decision. It never changes configuration or enables delivery.

## Configuration

```json
{
  "data_sources": {
    "robinhood_chain": {
      "enabled": false,
      "phase1": {
        "enabled": false,
        "delivery": "shadow",
        "phase2": {
          "enabled": false,
          "delivery": "shadow",
          "field_run_revision": "phase2-v3-readiness-epoch",
          "collect_seconds": 300,
          "lookback_hours": 24,
          "source_max_age_seconds": 600,
          "min_observation_hours": 72,
          "min_successful_runs": 800,
          "max_run_gap_seconds": 900,
          "max_source_error_rate": 0.05,
          "min_audited_windows": 1,
          "min_reviewed_alerts": 10,
          "retention_days": 30
        }
      }
    }
  }
}
```

All three enable switches are required for daemon scheduling. `delivery` accepts only `shadow` in Phase 2.

For the 72-hour field run, use the dedicated `robinhood-shadow-daemon` with an isolated `KING_AI_CONFIG_DIR`.
It is fail-closed unless all three phases are enabled, schedules the collectors sequentially, owns a dedicated
PID lock, and never enters the general trade scheduler or its alert, briefing, Telegram, or LLM paths.

## Compatibility and rollback

Phase 2 is additive. Phase 0 and Phase 1 do not read the Phase 2 database, so older code can ignore it. Disable `phase2.enabled` and restart the daemon to stop materialization. The database is retained for audit and is never deleted automatically.

## Verification

- config bounds and rejection of non-shadow delivery;
- disabled mode creates no Phase 2 database;
- missing/unhealthy/stale Phase 1 source fails closed;
- qualified candidates materialize idempotently and stale candidates invalidate drafts;
- exact-address X enrichment cannot create a draft;
- review records are bounded and only accept explicit verdicts;
- readiness duration, run count, gap, error-rate, audit, and review gates;
- focused build/tests, full `pnpm lint`, `pnpm verify`, and `git diff --check`.

The 72-hour field run is not part of source verification and must be completed separately before any live-delivery decision.
