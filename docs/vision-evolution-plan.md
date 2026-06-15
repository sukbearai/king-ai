# King AI Vision Evolution Plan

Approved 2026-06-15 (@suk.bear Go Phase 1).

## Verdict

Long-horizon execution + coordination substrate already exists (Initiative→Capsule→Task DAG, recall, plan apply, eval).
The one real gap: no goal-gap → next-step self-driver. Advancement is event-driven (human message → task), not vision-driven.

## Phase 1 (NOW)

- `king-ai initiative advance <id>` — read goal + linked tasks/capsules, emit gap context, optionally apply ExecutionPlan via plan apply
- `king-ai initiative persist` — mirror this plan into runtime `doc` + `context`
- Explicit trigger only; no wake/routing changes in v1
- Acceptance: on a real initiative, generated task DAG ships without human edits

## Phase 2 (later)

- Capsule execution via optional orca adapter (worktree + terminal spawn)
- Keep orca optional; do not clash with king-ai worktree.ts

## Phase 3 (later)

- Idle self-drive after Phase 1 acceptance passes

## Do NOT (now)

- Auto-create initiative from chat intent detection
- WorkspaceProvider abstraction
- Embed full VAS stack
- GUI vision tree (YAGNI)