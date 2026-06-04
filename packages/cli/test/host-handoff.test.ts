import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostCommand } from "../src/host-control.js";

interface CardJson { card?: { id?: string; ownerRole?: string; status?: string }; handoffs?: Array<{ reason?: string; card?: { id?: string; kind?: string; ownerRole?: string; status?: string } }> }

const at = (iso: string) => () => new Date(iso);

test("workflow-update auto-routes a completed card to its reviewer", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-handoff-")), "out");

  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "task-1", title: "Implement feature", ownerRole: "builder" }
  }, { now: at("2026-06-04T00:00:00.000Z") });

  const done = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "task-1", status: "done", result: "implemented" }
  }, { now: at("2026-06-04T00:00:01.000Z") });

  const json = done.json as CardJson;
  assert.equal(json.handoffs?.length, 1);
  assert.equal(json.handoffs?.[0]?.reason, "review");
  assert.equal(json.handoffs?.[0]?.card?.kind, "review");
  assert.equal(json.handoffs?.[0]?.card?.ownerRole, "reviewer");
  assert.match(done.text, /auto-handoff \(review\)/);

  // The review card is persisted to the ledger and addressed to the reviewer.
  const listed = await runHostCommand({ command: "workflow-list", input: { outputDir, reviewerRole: "reviewer" } });
  assert.equal((listed.json as { cards?: Array<{ kind?: string }> }).cards?.some((card) => card.kind === "review"), true);
});

test("workflow-update does not duplicate auto-handoffs for an already completed card", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-handoff-idempotent-")), "out");

  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "task-1", title: "Implement feature", ownerRole: "builder" }
  }, { now: at("2026-06-04T00:00:00.000Z") });

  const first = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "task-1", status: "done", result: "implemented" }
  }, { now: at("2026-06-04T00:00:01.000Z") });
  assert.equal((first.json as CardJson).handoffs?.length, 1);

  const second = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "task-1", status: "done", result: "implemented again" }
  }, { now: at("2026-06-04T00:00:02.000Z") });
  assert.equal((second.json as CardJson).handoffs, undefined);

  const listed = await runHostCommand({ command: "workflow-list", input: { outputDir, kind: "review" } });
  assert.equal((listed.json as { cards?: Array<{ kind?: string }> }).cards?.length, 1);
});

test("workflow-update chains review -> nextRole and honors the per-call opt-out", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-handoff-chain-")), "out");
  const policy = { mode: "review-required", reviewerRole: "reviewer", escalation: "coordinator", acceptanceRequired: true, nextRole: "doc-writer" };

  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "handoff", id: "h1", title: "Build then doc", ownerRole: "builder", reviewerRole: "reviewer", handoffPolicy: policy }
  }, { now: at("2026-06-04T00:00:00.000Z") });

  const reviewed = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "h1", status: "done", result: "built" }
  }, { now: at("2026-06-04T00:00:01.000Z") });
  const reviewCardId = (reviewed.json as CardJson).handoffs?.[0]?.card?.id;
  assert.ok(reviewCardId);

  // Completing the review hands off to the carried nextRole.
  const handedOff = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: reviewCardId, status: "done", result: "approved" }
  }, { now: at("2026-06-04T00:00:02.000Z") });
  const next = (handedOff.json as CardJson).handoffs?.[0];
  assert.equal(next?.reason, "next-role");
  assert.equal(next?.card?.ownerRole, "doc-writer");

  // Opt-out suppresses routing even when the card reaches done.
  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "task-noop", title: "No routing", ownerRole: "builder" }
  }, { now: at("2026-06-04T00:00:03.000Z") });
  const suppressed = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "task-noop", status: "done", handoff: false }
  }, { now: at("2026-06-04T00:00:04.000Z") });
  assert.equal((suppressed.json as CardJson).handoffs, undefined);
});

test("workflow-update rejects done when dependencies or acceptance evidence are missing", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-handoff-state-")), "out");

  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "dep", title: "Dependency", ownerRole: "builder" }
  }, { now: at("2026-06-04T00:00:00.000Z") });
  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "main", title: "Main", ownerRole: "builder", dependsOn: ["dep"], acceptance: ["evidence recorded"] }
  }, { now: at("2026-06-04T00:00:01.000Z") });

  await assert.rejects(
    runHostCommand({ command: "workflow-update", input: { outputDir, id: "main", status: "done", result: "implemented" } }),
    /depends on unfinished workflow cards: dep/
  );

  await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "dep", status: "done" }
  }, { now: at("2026-06-04T00:00:02.000Z") });

  await assert.rejects(
    runHostCommand({ command: "workflow-update", input: { outputDir, id: "main", status: "done" } }),
    /requires result or artifactPath/
  );

  const done = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "main", status: "done", artifactPath: "artifacts/main.md" }
  }, { now: at("2026-06-04T00:00:03.000Z") });
  assert.equal((done.json as CardJson).card?.status, "done");
});

test("review completion requires a verdict and routes changes back to the source owner", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-review-verdict-")), "out");

  await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "task-1", title: "Implement feature", ownerRole: "builder" }
  }, { now: at("2026-06-04T00:00:00.000Z") });

  const done = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: "task-1", status: "done", result: "implemented" }
  }, { now: at("2026-06-04T00:00:01.000Z") });
  const reviewCardId = (done.json as CardJson).handoffs?.[0]?.card?.id;
  assert.ok(reviewCardId);

  await assert.rejects(
    runHostCommand({ command: "workflow-update", input: { outputDir, id: reviewCardId, status: "done", result: "looks fine" } }),
    /requires result=approved or result=changes_requested/
  );

  const changes = await runHostCommand({
    command: "workflow-update",
    input: { outputDir, id: reviewCardId, status: "done", result: "changes_requested" }
  }, { now: at("2026-06-04T00:00:02.000Z") });
  const next = (changes.json as CardJson).handoffs?.[0];
  assert.equal(next?.reason, "next-role");
  assert.equal(next?.card?.kind, "handoff");
  assert.equal(next?.card?.ownerRole, "builder");
  assert.equal(next?.card?.status, "assigned");
});

test("workflow-create assigns an owner by capability when none is given", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-capability-")), "out");
  const created = await runHostCommand({
    command: "workflow-create",
    input: { outputDir, kind: "task", id: "verify-1", title: "Verify the release", requiredCapabilities: ["testing", "verification"] }
  }, { now: at("2026-06-04T00:00:00.000Z") });
  assert.equal((created.json as CardJson).card?.ownerRole, "tester");
});

test("compact-ledger requires confirmation and rewrites the merged ledger", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-compact-")), "out");
  // autoHandoff disabled so the only workflow records are the ones under test.
  const deps = { autoHandoff: false, now: at("2026-06-04T00:00:00.000Z") };
  await runHostCommand({ command: "workflow-create", input: { outputDir, kind: "task", id: "c1", title: "Card one", ownerRole: "builder" } }, deps);
  await runHostCommand({ command: "workflow-update", input: { outputDir, id: "c1", status: "in_progress" } }, deps);
  await runHostCommand({ command: "workflow-update", input: { outputDir, id: "c1", status: "done" } }, deps);

  // Destructive: rejected without confirmation.
  const blocked = await runHostCommand({ command: "compact-ledger", input: { outputDir } });
  assert.equal(blocked.exitCode, 75);

  const compacted = await runHostCommand({ command: "compact-ledger", input: { outputDir, confirmed: true } });
  assert.equal(compacted.ok, true);
  const workflow = (compacted.json as { workflow?: { records?: number; written?: number } }).workflow;
  // Three append records (1 create + 2 updates) collapse into a single merged card.
  assert.equal(workflow?.records, 3);
  assert.equal(workflow?.written, 1);

  // The merged card survives compaction with its latest status.
  const listed = await runHostCommand({ command: "workflow-list", input: { outputDir } });
  const cards = (listed.json as { cards?: Array<{ id?: string; status?: string }> }).cards;
  assert.equal(cards?.length, 1);
  assert.equal(cards?.[0]?.status, "done");
});
