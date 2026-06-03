import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_VERSION } from "../src/paths.js";
import {
  checkForUpdate,
  formatRunningEventSummary,
  formatRecentRunningEvents,
  formatRunningStateSnapshot,
  formatWatchSnapshot,
  groupRunningEvents,
  parseDarwinLaunchctlStatus,
  parseLinuxMainPid,
  runningEventCategory,
  updateRunningStateData,
  rotateLogsIfNeeded,
  serviceNames,
  shouldKillDaemonCommand,
  updateRegistryUrl,
  versionGt,
  worktreePlansFromRunningState
} from "../src/service.js";

test("versionGt compares semver triples", () => {
  assert.equal(versionGt("1.2.4", "1.2.3"), true);
  assert.equal(versionGt("1.3.0", "1.2.99"), true);
  assert.equal(versionGt("1.2.3", "1.2.3"), false);
  assert.equal(versionGt("1.2.2", "1.2.3"), false);
});

test("checkForUpdate returns newer npm version only", async () => {
  const urls: string[] = [];
  const newer = await checkForUpdate(async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ version: "99.0.0" }));
  });
  assert.equal(newer, "99.0.0");
  const same = await checkForUpdate(async () => new Response(JSON.stringify({ version: CURRENT_VERSION })));
  assert.equal(same, null);
  assert.deepEqual(urls, ["https://registry.npmjs.org/%40suwujs%2Fking/latest"]);
});

test("serviceNames selects King package and service names", () => {
  assert.deepEqual(serviceNames("king"), {
    packageName: "@suwujs/king",
    serviceUnit: "king",
    displayName: "King",
    serviceLabel: "io.king.daemon"
  });
  assert.equal(updateRegistryUrl("king"), "https://registry.npmjs.org/%40suwujs%2Fking/latest");
});

test("rotateLogsIfNeeded preserves previous log as daemon.log.1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-service-"));
  await mkdir(dir, { recursive: true });
  const log = join(dir, "daemon.log");
  await writeFile(log, "large", "utf8");
  await rotateLogsIfNeeded(log, 1);
  assert.equal(await readFile(log, "utf8"), "");
  assert.equal(await readFile(`${log}.1`, "utf8"), "large");
});

test("shouldKillDaemonCommand only matches active foreground daemon runs", () => {
  assert.equal(shouldKillDaemonCommand("node dist/cli.js agent computer --server http://localhost:8787"), true);
  assert.equal(shouldKillDaemonCommand("tsx src/cli.ts agent computer --server http://localhost:8787"), true);
  assert.equal(shouldKillDaemonCommand("node dist/cli.js agent computer --status"), false);
  assert.equal(shouldKillDaemonCommand("node dist/cli.js agent computer --pair demo"), false);
  assert.equal(shouldKillDaemonCommand("npx -y king@latest agent computer --server http://localhost:8787"), false);
  assert.equal(shouldKillDaemonCommand("node dist/cli.js agent other"), false);
});

test("parseDarwinLaunchctlStatus reads pid and last exit status", () => {
  const status = parseDarwinLaunchctlStatus(`{
    "LimitLoadToSessionType" = "Aqua";
    "LastExitStatus" = 70;
    "PID" = 12345;
  }`);
  assert.deepEqual(status, { pid: 12345, lastExitStatus: 70 });

  assert.deepEqual(parseDarwinLaunchctlStatus('{ "LastExitStatus" = -1; }'), {
    pid: null,
    lastExitStatus: -1
  });
});

test("parseLinuxMainPid ignores empty and zero pids", () => {
  assert.equal(parseLinuxMainPid("456\n"), 456);
  assert.equal(parseLinuxMainPid("0\n"), null);
  assert.equal(parseLinuxMainPid("\n"), null);
});

test("updateRunningStateData merges daemon status and keeps a bounded event buffer", () => {
  const base = updateRunningStateData(null, {
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    capabilities: { workspaces: ["/Users/fayon/workspace/github"] },
    event: { at: "2026-06-02T00:00:01.000Z", kind: "daemon.started" }
  });
  assert.equal(base.computerId, "demo-computer");
  assert.deepEqual(base.capabilities?.workspaces, ["/Users/fayon/workspace/github"]);
  assert.equal(base.events?.length, 1);

  let state = base;
  for (let i = 0; i < 60; i += 1) {
    state = updateRunningStateData(state, {
      event: { at: `2026-06-02T00:00:${String(i).padStart(2, "0")}.000Z`, kind: `event.${i}` }
    });
  }
  assert.equal(state.events?.length, 50);
  assert.equal(state.events?.[0]?.kind, "event.10");
  assert.equal(state.events?.at(-1)?.kind, "event.59");
});

test("formatRecentRunningEvents renders tail events for logs", () => {
  const state = updateRunningStateData(null, {
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    event: { at: "2026-06-02T00:00:01.000Z", kind: "daemon.started", detail: "demo-computer" }
  });
  const rendered = formatRecentRunningEvents(state);
  assert.match(rendered, /recent daemon events/);
  assert.match(rendered, /daemon\.started: demo-computer/);
  assert.equal(formatRecentRunningEvents(null), "");
});

test("running event classification groups agent, turn, budget, daemon, and other events", () => {
  assert.equal(runningEventCategory("agent.started"), "agent");
  assert.equal(runningEventCategory("agent.budget_exceeded"), "budget");
  assert.equal(runningEventCategory("turn.completed"), "turn");
  assert.equal(runningEventCategory("agenda.started"), "turn");
  assert.equal(runningEventCategory("wake.received"), "turn");
  assert.equal(runningEventCategory("heartbeat.failed"), "daemon");
  assert.equal(runningEventCategory("custom.event"), "other");

  const grouped = groupRunningEvents([
    { at: "1", kind: "agent.started" },
    { at: "2", kind: "turn.completed" },
    { at: "3", kind: "agent.budget_warning" },
    { at: "4", kind: "heartbeat.failed" },
    { at: "5", kind: "custom.event" }
  ]);
  assert.equal(grouped.agent.length, 1);
  assert.equal(grouped.turn.length, 1);
  assert.equal(grouped.budget.length, 1);
  assert.equal(grouped.daemon.length, 1);
  assert.equal(grouped.other.length, 1);
  assert.match(formatRunningEventSummary({ version: "0.1.0", pid: 1, startedAt: "0", events: grouped.agent }), /events by category/);
});

test("formatRunningStateSnapshot and watch snapshot summarize daemon state", () => {
  const state = updateRunningStateData(null, {
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    serverUrl: "http://localhost:8787",
    computerId: "demo-computer",
    lastHeartbeatAt: "2026-06-02T00:00:02.000Z",
    lastSyncAt: "2026-06-02T00:00:03.000Z",
    capabilities: { workspaces: ["/Users/fayon/workspace/github"] },
    agents: [{
      id: "demo-agent",
      name: "Demo Agent",
      engine: "codex",
      lifecycle: "on-demand",
      status: "idle",
      model: "gpt-test",
      sharedSkillSnapshot: {
        id: "skills-demo",
        root: "/tmp/snapshots/skills-demo",
        manifestPath: "/tmp/snapshots/skills-demo/manifest.json",
        skills: ["takeover-context", "workspace-conventions"]
      },
      hostHomeEntries: [
        { name: ".gitconfig", source: "/Users/demo/.gitconfig", target: "/tmp/agents/demo-agent/.gitconfig", linked: true },
        { name: ".missing", source: "/Users/demo/.missing", target: "/tmp/agents/demo-agent/.missing", linked: false, reason: "source does not exist" }
      ],
      workspaceRoot: "/tmp/agents/demo-agent",
      runStats: {
        turns: 2,
        completed: 1,
        failed: 1,
        inputTokens: 20,
        cacheReadInputTokens: 5,
        outputTokens: 10,
        totalTokens: 35,
        lastRunAt: "2026-06-02T00:00:04.500Z",
        lastDurationMs: 1500,
        lastStatus: "failed",
        lastModel: "gpt-test"
      },
      tokenBudget: {
        budget: 40,
        used: 35,
        remaining: 5,
        warning: true,
        exceeded: false,
        state: "warning"
      },
      remediation: {
        engine: "codex",
        category: "quota",
        severity: "error",
        summary: "codex quota or billing limit is blocking runs",
        detail: "usage limit reached",
        actions: [
          "Open codex locally and refresh quota, billing, credits, or subscription state.",
          "Re-run: king agent computer --doctor"
        ]
      },
      configWarnings: [{
        code: "idle-cached-without-resume",
        severity: "warning",
        summary: "idle_cached has engine-specific resume semantics",
        detail: "Codex app-server thread reuse is best-effort."
      }],
      worktreePlans: [{
        repoRoot: "/Users/fayon/workspace/github/king",
        repoName: "king",
        repoUrl: "git@github.com:fayon/king.git",
        branch: "agent/demo-agent",
        worktreePath: "/tmp/agents/demo-agent/king",
        command: ["git", "-C", "/Users/fayon/workspace/github/king", "worktree", "add", "-B", "agent/demo-agent", "/tmp/agents/demo-agent/king"]
      }],
      updatedAt: "2026-06-02T00:00:04.000Z"
    }],
    event: { at: "2026-06-02T00:00:05.000Z", kind: "agent.hosting", detail: "demo-agent on codex" }
  });
  const stateWithEvents = updateRunningStateData(state, {
    event: { at: "2026-06-02T00:00:06.000Z", kind: "turn.completed", detail: "run-1" }
  });

  const snapshot = formatRunningStateSnapshot(stateWithEvents);
  assert.match(snapshot, /heartbeat: 2026-06-02T00:00:02\.000Z/);
  assert.match(snapshot, /demo-agent Demo Agent on codex lifecycle=on-demand status=idle model=gpt-test/);
  assert.match(snapshot, /workspace=\/tmp\/agents\/demo-agent/);
  assert.match(snapshot, /usage: runs=2 completed=1 failed=1 35 tokens \(in=20, cache=5, out=10\) last=failed 1500ms/);
  assert.match(snapshot, /token budget: budget=40 used=35 remaining=5 state=warning/);
  assert.match(snapshot, /remediation: codex quota or billing limit is blocking runs/);
  assert.match(snapshot, /Re-run: king agent computer --doctor/);
  assert.match(snapshot, /config warning: idle-cached-without-resume - idle_cached has engine-specific resume semantics/);
  assert.match(snapshot, /skill snapshot: skills-demo \(takeover-context, workspace-conventions\) \/tmp\/snapshots\/skills-demo\/manifest\.json/);
  assert.match(snapshot, /host home entry: \.gitconfig -> \/tmp\/agents\/demo-agent\/\.gitconfig/);
  assert.match(snapshot, /host home entry: \.missing -> \/tmp\/agents\/demo-agent\/\.missing \(source does not exist\)/);
  assert.match(snapshot, /worktree plan: king -> \/tmp\/agents\/demo-agent\/king \(agent\/demo-agent\) from git@github\.com:fayon\/king\.git/);
  assert.match(snapshot, /events by category/);
  assert.match(snapshot, /agent:/);
  assert.match(snapshot, /agent\.hosting: demo-agent on codex/);
  assert.match(snapshot, /turn:/);
  assert.match(snapshot, /turn\.completed: run-1/);

  const watch = formatWatchSnapshot(stateWithEvents, new Date("2026-06-02T00:00:06.000Z"));
  assert.match(watch, /king watch 2026-06-02T00:00:06\.000Z/);
  assert.match(watch, /running: 0\.1\.0 pid=123/);
  assert.match(watch, /paired: demo-computer @ http:\/\/localhost:8787/);
  assert.match(formatWatchSnapshot(null), /no running\.json found/);
});

test("worktreePlansFromRunningState extracts unique plans from agents", () => {
  const plan = {
    repoRoot: "/repo",
    repoName: "repo",
    branch: "agent/demo",
    worktreePath: "/agents/demo/repo",
    command: ["git", "-C", "/repo", "worktree", "add", "-B", "agent/demo", "/agents/demo/repo"]
  };
  const state = updateRunningStateData(null, {
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    agents: [
      { id: "a", name: "A", engine: "codex", worktreePlans: [plan], updatedAt: "2026-06-02T00:00:01.000Z" },
      { id: "b", name: "B", engine: "claude", worktreePlans: [plan], updatedAt: "2026-06-02T00:00:02.000Z" }
    ]
  });
  assert.deepEqual(worktreePlansFromRunningState(state), [plan]);
  assert.deepEqual(worktreePlansFromRunningState(null), []);
});
