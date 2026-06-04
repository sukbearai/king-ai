import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportHostArtifacts, planHostExport } from "../src/host-export.js";
import { createHostCapsule } from "../src/host-ledger.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

test("planHostExport previews workspace deliverables and dirty repo patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-export-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(workspace, "result.txt"), "done", "utf8");
  await writeFile(join(workspace, "node_modules", "pkg", "skip.txt"), "skip", "utf8");
  await mkdir(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "app.txt"), "before\n", "utf8");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  await writeFile(join(repo, "app.txt"), "after\n", "utf8");

  const plan = await planHostExport({
    workspaceRoot: workspace,
    repoRoot: repo,
    outputDir: join(root, "deliverables"),
    runId: "run-1"
  });

  assert.equal(plan.workspaceFileCount, 1);
  assert.equal(plan.repoDirty, true);
  assert.deepEqual(plan.files, ["workspace/", "repo-status.txt", "repo.patch", "meta.json"]);
  assert.match(plan.summary, /host export: run-1/);
  assert.match(plan.summary, /meta\.json/);
});

test("exportHostArtifacts writes workspace files and repo patch bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-export-write-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  const output = join(root, "deliverables");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "result.txt"), "done", "utf8");
  await mkdir(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "app.txt"), "before\n", "utf8");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  await writeFile(join(repo, "app.txt"), "after\n", "utf8");

  const result = await exportHostArtifacts({
    workspaceRoot: workspace,
    repoRoot: repo,
    outputDir: output,
    runId: "run-1"
  });

  assert.equal(existsSync(join(output, "run-1", "workspace", "result.txt")), true);
  assert.match(await readFile(join(output, "run-1", "repo-status.txt"), "utf8"), /app\.txt/);
  assert.match(await readFile(join(output, "run-1", "repo.patch"), "utf8"), /diff --git/);
  const meta = JSON.parse(await readFile(join(output, "run-1", "meta.json"), "utf8")) as {
    schema: string;
    runId: string;
    workspaceFileCount: number;
    repoDirty: boolean;
    files: string[];
    writtenFiles: string[];
  };
  assert.equal(meta.schema, "king.host-export.v1");
  assert.equal(meta.runId, "run-1");
  assert.equal(meta.workspaceFileCount, 1);
  assert.equal(meta.repoDirty, true);
  assert.deepEqual(meta.files, ["workspace/", "repo-status.txt", "repo.patch", "meta.json"]);
  assert.equal(meta.writtenFiles.some((file) => file.endsWith("meta.json")), true);
  assert.equal(result.writtenFiles.some((file) => file.endsWith("repo.patch")), true);
  assert.equal(result.writtenFiles.some((file) => file.endsWith("meta.json")), true);
});

test("exportHostArtifacts includes capsule closure metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-export-capsule-"));
  const workspace = join(root, "workspace");
  const output = join(root, "deliverables");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "result.txt"), "done", "utf8");
  await createHostCapsule({
    outputDir: output,
    id: "capsule-1",
    goal: "Ship scoped result",
    owner: "dev",
    branchOrWorktree: "agent/dev",
    allowedPaths: ["packages/cli/src/host-export.ts"],
    acceptance: ["export contains capsule metadata"],
    reviewer: "cto",
    verificationCommands: ["pnpm --filter @suwujs/king test"]
  }, () => new Date("2026-06-02T00:00:00.000Z"));

  const plan = await planHostExport({
    workspaceRoot: workspace,
    outputDir: output,
    runId: "run-1",
    capsuleId: "capsule-1"
  });
  assert.equal(plan.capsule?.id, "capsule-1");
  assert.deepEqual(plan.files, ["workspace/", "capsule.json", "meta.json"]);

  const result = await exportHostArtifacts({
    workspaceRoot: workspace,
    outputDir: output,
    runId: "run-1",
    capsuleId: "capsule-1"
  });
  assert.equal(result.writtenFiles.some((file) => file.endsWith("capsule.json")), true);
  const meta = JSON.parse(await readFile(join(output, "run-1", "meta.json"), "utf8")) as { capsule?: { id?: string; owner?: string } };
  assert.equal(meta.capsule?.id, "capsule-1");
  assert.equal(meta.capsule?.owner, "dev");
});

test("planHostExport rejects run IDs that are not safe filename segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-export-unsafe-"));
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "keep.txt"), "keep", "utf8");

  await assert.rejects(
    () => planHostExport({ outputDir: join(root, "deliverables"), runId: "../../outside" }),
    /runId must be a safe filename segment/
  );
  await assert.rejects(
    () => planHostExport({ outputDir: join(root, "deliverables"), runId: "nested/run" }),
    /runId must be a safe filename segment/
  );
  await assert.rejects(
    () => exportHostArtifacts({ outputDir: join(root, "deliverables"), runId: "../../outside" }),
    /runId must be a safe filename segment/
  );
  assert.equal(existsSync(join(outside, "keep.txt")), true);
});

test("planHostExport rejects invalid repo roots", async () => {
  await assert.rejects(() => planHostExport({ repoRoot: "/path/that/does/not/exist" }), /repoRoot does not exist/);
});
