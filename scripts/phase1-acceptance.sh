#!/usr/bin/env bash
# Phase 1 acceptance: vision persist + initiative advance --auto on a real initiative.
set -euo pipefail

echo "== Phase 1 acceptance =="

echo "[1/4] Persist vision plan to runtime doc + context"
king-ai initiative persist
phase="$(king-ai context get vision.plan.phase)"
if [[ "$phase" != "1" ]]; then
  echo "FAIL: vision.plan.phase expected '1', got '$phase'" >&2
  exit 1
fi
echo "OK: vision.plan.phase=$phase"

initiative_id="$(king-ai context get vision.plan.initiativeId 2>/dev/null || true)"
if [[ -z "$initiative_id" || "$initiative_id" == *"not found"* ]]; then
  echo "[2/4] Create acceptance initiative"
  out="$(king-ai initiative create 'Phase 1 acceptance' --goal 'Validate initiative advance generates a usable task DAG without manual edits')"
  initiative_id="$(echo "$out" | rg -o 'initiative-[0-9]+-[a-z0-9]+' | head -1)"
fi
echo "Initiative: $initiative_id"

echo "[3/4] Dry-run gap report"
king-ai initiative advance "$initiative_id" --dry-run

echo "[4/4] Auto-apply plan (heuristic scaffold)"
king-ai initiative advance "$initiative_id" --auto --assign dev

echo "Tasks linked to initiative:"
king-ai task list 2>/dev/null | rg "$initiative_id" || king-ai task list

echo "PASS: Phase 1 acceptance script completed. Review tasks manually for ship-without-edits criterion."