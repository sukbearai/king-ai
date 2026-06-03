import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHostStatusSnapshot, formatHostStatusSnapshot } from "../src/host-api.js";

test("buildHostStatusSnapshot normalizes running state for host apps", () => {
  const snapshot = buildHostStatusSnapshot({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    serverUrl: "http://localhost:8787",
    computerId: "demo-computer",
    capabilities: { workspaces: ["/workspace/github"] },
    agents: [{
      id: "demo-agent",
      name: "Demo Agent",
      engine: "codex",
      lifecycle: "on-demand",
      status: "idle",
      model: "gpt-test",
      workspaceRoot: "/agents/demo-agent",
      sharedSkillSnapshot: {
        id: "skills-demo",
        root: "/snapshots/skills-demo",
        manifestPath: "/snapshots/skills-demo/manifest.json",
        skills: ["workspace"]
      },
      hostHomeEntries: [
        { name: ".gitconfig", source: "/home/demo/.gitconfig", target: "/agents/demo-agent/.gitconfig", linked: true }
      ],
      remediation: {
        engine: "codex",
        category: "auth",
        severity: "error",
        summary: "codex authentication is not ready",
        detail: "not logged in",
        actions: ["Open codex locally and sign in again.", "Re-run: king agent computer --doctor"]
      },
      configWarnings: [{
        code: "idle-cached-without-resume",
        severity: "warning",
        summary: "idle_cached has engine-specific resume semantics",
        detail: "Codex app-server thread reuse is best-effort."
      }],
      runStats: {
        turns: 1,
        completed: 1,
        failed: 0,
        inputTokens: 10,
        cacheReadInputTokens: 2,
        outputTokens: 8,
        totalTokens: 20
      },
      updatedAt: "2026-06-02T00:00:01.000Z"
    }],
    events: [{ at: "2026-06-02T00:00:02.000Z", kind: "agent.started" }]
  }, 100);

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.computerId, "demo-computer");
  assert.deepEqual(snapshot.capabilities.workspaces, ["/workspace/github"]);
  assert.equal(snapshot.agents[0].sharedSkillSnapshotId, "skills-demo");
  assert.deepEqual(snapshot.agents[0].hostHomeEntries, [{ name: ".gitconfig", linked: true, reason: undefined }]);
  assert.deepEqual(snapshot.agents[0].remediation, {
    category: "auth",
    severity: "error",
    summary: "codex authentication is not ready",
    actions: ["Open codex locally and sign in again.", "Re-run: king agent computer --doctor"]
  });
  assert.equal(snapshot.agents[0].configWarnings?.[0]?.code, "idle-cached-without-resume");
  assert.equal(snapshot.usage.totalTokens, 20);
  assert.equal(snapshot.usage.budget?.state, "ok");
  assert.match(snapshot.text, /demo-agent Demo Agent on codex/);
});

test("formatHostStatusSnapshot handles missing daemon state", () => {
  const snapshot = buildHostStatusSnapshot(null);
  assert.equal(snapshot.ok, false);
  assert.match(formatHostStatusSnapshot(snapshot), /daemon is not running/);
});
