import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
    env: { ...process.env, KING_AI_AGENT_RUNTIME_URL: undefined, KING_AI_AGENT_RUNTIME_TOKEN: undefined, ...env },
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

// Captures the body the shim POSTs to /cli so we can assert which runId/contract it forwarded.
async function captureCliPost(
  shim: string,
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ runId?: string; contract?: { taskId?: string } }> {
  let captured: { runId?: string; contract?: { taskId?: string } } = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        captured = JSON.parse(raw);
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "", exitCode: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // Must spawn asynchronously: spawnSync would block this process's event loop, so the in-process
    // HTTP server could never handle the shim's request.
    const child = spawn("node", [shim, ...argv], {
      env: {
        ...process.env,
        KING_AI_AGENT_RUNTIME_URL: `http://127.0.0.1:${port}`,
        KING_AI_AGENT_RUNTIME_TOKEN: "t",
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return captured;
}

test("shim forwards the run file's runId/contract over the frozen spawn-time env", async () => {
  const { shim } = await setupShim();
  const runFile = join(await mkdtemp(join(tmpdir(), "king-ai-run-")), ".runtime-run");
  await writeFile(runFile, JSON.stringify({ runId: "run-fresh", contract: { taskId: "task-fresh" } }), "utf8");

  // Env carries the STALE first-wake values a persistent session was spawned with; the run file is
  // the live turn. The shim must send the file's values so `task done task-fresh` is accepted.
  const fresh = await captureCliPost(shim, ["task", "done", "task-fresh"], {
    KING_AI_AGENT_RUNTIME_RUN_ID: "run-stale",
    KING_AI_AGENT_RUNTIME_CONTRACT: JSON.stringify({ taskId: "task-stale" }),
    KING_AI_AGENT_RUNTIME_RUN_FILE: runFile,
  });
  assert.equal(fresh.runId, "run-fresh");
  assert.equal(fresh.contract?.taskId, "task-fresh");

  // With no run file, the shim falls back to the env values (backward compatible).
  const fallback = await captureCliPost(shim, ["task", "done", "task-stale"], {
    KING_AI_AGENT_RUNTIME_RUN_ID: "run-stale",
    KING_AI_AGENT_RUNTIME_CONTRACT: JSON.stringify({ taskId: "task-stale" }),
  });
  assert.equal(fallback.runId, "run-stale");
  assert.equal(fallback.contract?.taskId, "task-stale");
});
