import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anyRunnerBusy, clearLocalRuntimeState, doctorExitCode, formatDoctorReport, installLogTimestamps, missingEngineMessage, parsePairLocator, resolveHostName, shouldExitForUpdate, waitForRunnerIdle } from "../src/daemon.js";

test("anyRunnerBusy reports whether any runner is active", () => {
  assert.equal(anyRunnerBusy([]), false);
  assert.equal(anyRunnerBusy([{ isBusy: false }, { isBusy: false }]), false);
  assert.equal(anyRunnerBusy([{ isBusy: false }, { isBusy: true }]), true);
});

test("waitForRunnerIdle returns when runner becomes idle", async () => {
  let busy = true;
  setTimeout(() => { busy = false; }, 50);
  const idle = await waitForRunnerIdle({ get isBusy() { return busy; } }, 500, 10);
  assert.equal(idle, true);
});

test("installLogTimestamps prefixes daemon log lines with an ISO wall-clock time", () => {
  const flag = Symbol.for("king-ai.logTimestamps");
  const globalState = globalThis as unknown as Record<symbol, boolean>;
  const originalLog = console.log;
  const originalFlag = globalState[flag];
  const captured: unknown[][] = [];
  try {
    delete globalState[flag];
    console.log = (...args: unknown[]) => { captured.push(args); };
    installLogTimestamps(() => new Date("2026-06-10T08:02:02.913Z"));
    installLogTimestamps(); // idempotent: a second install must not double-wrap
    console.log("[dev/codex] SSE wake received");
    assert.deepEqual(captured, [["[2026-06-10T08:02:02.913Z]", "[dev/codex] SSE wake received"]]);
  } finally {
    console.log = originalLog;
    if (originalFlag) globalState[flag] = originalFlag; else delete globalState[flag];
  }
});

test("shouldExitForUpdate waits for update readiness, idle runners, and no shutdown", () => {
  assert.equal(shouldExitForUpdate({ updateReady: false, shuttingDown: false, anyBusy: false }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: true, anyBusy: false }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: false, anyBusy: true }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: false, anyBusy: false }), true);
});

test("resolveHostName avoids localhost and uses platform names on macOS", () => {
  assert.equal(resolveHostName("workstation", "linux"), "workstation");
  assert.equal(resolveHostName("localhost", "darwin", ["", "Fayon Mac\n"]), "Fayon Mac");
  assert.equal(resolveHostName("localhost", "linux"), "localhost");
  assert.equal(resolveHostName("", "darwin", []), "My computer");
});

test("parsePairLocator supports GUI-provided server and tenant", () => {
  const locator = parsePairLocator("king-ai://pair?server=https%3A%2F%2Fgui.example.com%2F&tenant=user-octo&code=abc123");
  assert.deepEqual(locator, {
    code: "abc123",
    serverUrl: "https://gui.example.com",
    tenantId: "user-octo"
  });
  assert.deepEqual(parsePairLocator("plain-code"), { code: "plain-code" });
});

test("clearLocalRuntimeState removes generated runtime state but keeps pairing config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-reset-"));
  for (const subdir of ["agents/dev/workspace", "sessions", "triage"]) {
    await mkdir(join(dir, subdir), { recursive: true });
  }
  await writeFile(join(dir, "computer.json"), '{"deviceToken":"keep"}', "utf8");
  await writeFile(join(dir, "agents/dev/workspace/file.txt"), "drop", "utf8");
  await writeFile(join(dir, "sessions/dev.codex.session"), "drop", "utf8");
  await writeFile(join(dir, "triage/tmp.txt"), "drop", "utf8");
  await writeFile(join(dir, "running.json"), "drop", "utf8");
  await writeFile(join(dir, "heartbeat.json"), "drop", "utf8");

  await clearLocalRuntimeState({
    agentsRoot: join(dir, "agents"),
    sessionsDir: join(dir, "sessions"),
    triageDir: join(dir, "triage"),
    runningStatePath: join(dir, "running.json"),
    heartbeatPath: join(dir, "heartbeat.json")
  });

  assert.equal(existsSync(join(dir, "agents")), false);
  assert.equal(existsSync(join(dir, "sessions")), false);
  assert.equal(existsSync(join(dir, "triage")), false);
  assert.equal(existsSync(join(dir, "running.json")), false);
  assert.equal(existsSync(join(dir, "heartbeat.json")), false);
  assert.equal(await readFile(join(dir, "computer.json"), "utf8"), '{"deviceToken":"keep"}');
});

test("missingEngineMessage gives actionable install guidance", () => {
  const message = missingEngineMessage();
  assert.match(message, /Claude Code/);
  assert.match(message, /Codex/);
  assert.match(message, /Grok/);
  assert.match(message, /king-ai agent computer --pair <code>/);
});

test("formatDoctorReport summarizes brains, failures, and install guidance", () => {
  const report = formatDoctorReport(
    [
      { id: "claude", installed: false },
      {
        id: "codex",
        installed: true,
        path: "/usr/bin/codex",
        big: { ok: true },
        small: { ok: false, detail: "usage limit reached" }
      }
    ],
    "1.2.3"
  );

  assert.match(report, /king-ai 1\.2\.3 engine doctor/);
  assert.match(report, /big brain = main reasoning/);
  assert.match(report, /x claude - not found on PATH/);
  assert.match(report, /claude CLI is not on PATH/);
  assert.match(report, /o codex - \/usr\/bin\/codex/);
  assert.match(report, /ok big brain/);
  assert.match(report, /small brain.*FAILED: usage limit reached/);
  assert.match(report, /codex quota or billing limit is blocking runs/);
  assert.match(report, /king-ai agent computer --doctor/);
  assert.match(report, /no engine has BOTH brains healthy/);
});

test("formatDoctorReport omits unusable warning when one engine is healthy", () => {
  const report = formatDoctorReport([
    {
      id: "claude",
      installed: true,
      path: "claude",
      big: { ok: true },
      small: { ok: true }
    }
  ]);

  assert.doesNotMatch(report, /no engine has BOTH brains healthy/);
});

test("doctorExitCode fails only when no engine has both brains healthy", () => {
  assert.equal(doctorExitCode([{ id: "claude", installed: false }]), 1);
  assert.equal(doctorExitCode([{ id: "codex", installed: true, big: { ok: true }, small: { ok: false } }]), 1);
  assert.equal(doctorExitCode([{ id: "claude", installed: true, big: { ok: true }, small: { ok: true } }]), 0);
});
