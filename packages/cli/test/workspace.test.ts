import assert from "node:assert/strict";
import { delimiter, resolve } from "node:path";
import { test } from "node:test";
import { agentWorkspaceRoot, detectLocalCapabilities, formatWorkspacePolicy, resolveWorkspaceAllowlist } from "../src/workspace.js";

test("resolveWorkspaceAllowlist parses KING_AI_WORKSPACES with path delimiter and commas", () => {
  const paths = resolveWorkspaceAllowlist({
    KING_AI_WORKSPACES: [`~/workspace/github`, "/tmp/one,/tmp/two", "/tmp/one"].join(delimiter)
  } as NodeJS.ProcessEnv);

  assert.equal(paths[0].endsWith("/workspace/github"), true);
  assert.equal(paths[1], resolve("/tmp/one"));
  assert.equal(paths[2], resolve("/tmp/two"));
  assert.equal(paths.length, 3);
});

test("formatWorkspacePolicy explains allowed and unconfigured workspaces", () => {
  assert.match(formatWorkspacePolicy([]), /no external workspace directories/);
  const policy = formatWorkspacePolicy(["/Users/fayon/workspace/github"], "/tmp/agents/demo-agent");
  assert.match(policy, /allowed these external workspace directories/);
  assert.match(policy, /Agent workspace root: \/tmp\/agents\/demo-agent/);
  assert.match(policy, /\/Users\/fayon\/workspace\/github/);
  assert.match(policy, /use your agent workspace root/);
});

test("agentWorkspaceRoot uses configured per-agent base or private home workspace", () => {
  assert.equal(agentWorkspaceRoot("demo-agent", "/tmp/home/demo-agent", {} as NodeJS.ProcessEnv), resolve("/tmp/home/demo-agent/workspace"));
  assert.equal(
    agentWorkspaceRoot("demo-agent", "/tmp/home/demo-agent", { KING_AI_AGENT_WORKSPACE_ROOT: "/tmp/agent-worktrees" } as NodeJS.ProcessEnv),
    resolve("/tmp/agent-worktrees/demo-agent")
  );
  assert.equal(detectLocalCapabilities({ KING_AI_AGENT_WORKSPACE_ROOT: "/tmp/agent-worktrees" } as NodeJS.ProcessEnv).agentWorkspaceRoot, resolve("/tmp/agent-worktrees"));
});
