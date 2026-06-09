import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeShim } from "../src/shim.js";

async function setupShim(): Promise<{ shim: string; learnedDir: string; draft: string }> {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-shim-"));
  const binDir = join(dir, "bin");
  const learnedDir = join(dir, "learned");
  const draft = join(dir, "draft.md");
  await writeShim(binDir);
  await writeFile(draft, "# Deploy VLESS\n\nRun the deploy script, then verify the worker responds.\n", "utf8");
  return { shim: join(binDir, "king-ai"), learnedDir, draft };
}

function runShim(shim: string, args: string[], env: Record<string, string | undefined>) {
  return spawnSync("node", [shim, ...args], {
    encoding: "utf8",
    env: { ...process.env, KING_AI_AGENT_RUNTIME_URL: undefined, KING_AI_AGENT_RUNTIME_TOKEN: undefined, ...env }
  });
}

test("shim skill save persists a learned skill outside the runtime", async () => {
  const { shim, learnedDir, draft } = await setupShim();
  const env = { KING_AI_AGENT_LEARNED_SKILLS: learnedDir };

  const saved = runShim(shim, ["skill", "save", "deploy-vless", "--file", draft], env);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /saved learned skill deploy-vless/);
  const written = await readFile(join(learnedDir, "deploy-vless", "SKILL.md"), "utf8");
  assert.match(written, /Deploy VLESS/);

  const list = runShim(shim, ["skill", "list"], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /deploy-vless/);

  const show = runShim(shim, ["skill", "show", "deploy-vless"], env);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /verify the worker responds/);

  const removed = runShim(shim, ["skill", "remove", "deploy-vless"], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(runShim(shim, ["skill", "list"], env).stdout.trim(), "");
});

test("shim skill save validates name, content, and configuration", async () => {
  const { shim, learnedDir, draft } = await setupShim();
  const env = { KING_AI_AGENT_LEARNED_SKILLS: learnedDir };

  const badName = runShim(shim, ["skill", "save", "Bad Name", "some content"], env);
  assert.equal(badName.status, 64);
  assert.match(badName.stderr, /slug/);

  const empty = runShim(shim, ["skill", "save", "empty-skill"], env);
  assert.equal(empty.status, 64);
  assert.match(empty.stderr, /empty/);

  const unconfigured = runShim(shim, ["skill", "list"], { KING_AI_AGENT_LEARNED_SKILLS: undefined });
  assert.equal(unconfigured.status, 64);
  assert.match(unconfigured.stderr, /not configured/);

  // skill handling runs before the runtime check, so it never needs runtime env
  assert.doesNotMatch(badName.stderr, /runtime env not set/);
});
