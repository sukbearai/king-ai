import assert from "node:assert/strict";
import { test } from "node:test";
import { roleTemplateForAgent } from "@suwujs/king-ai/team-workflow";
import { DEFAULT_TEAM_AGENTS, IELTS_WORKFLOW_AGENTS } from "../src/gui-types.js";

const TEMPLATE_MARKER = /Role template:\s*[a-z-]+\./;

test("every built-in software-dev agent declares an explicit role template", () => {
  // Concrete roster maps to role templates by id; the summarizer template is intentionally
  // folded into the planner (king-ai-ceo), so it has no standalone agent here.
  const expected: Record<string, string> = {
    "king-ai-ceo": "planner",
    dev: "builder",
    reviewer: "reviewer",
    tester: "tester",
    ops: "ops",
    researcher: "researcher",
    "doc-writer": "doc-writer"
  };
  assert.deepEqual(
    DEFAULT_TEAM_AGENTS.map((agent) => agent.id),
    Object.keys(expected)
  );
  for (const agent of DEFAULT_TEAM_AGENTS) {
    assert.match(agent.role, TEMPLATE_MARKER, `agent ${agent.id} should carry a Role template marker`);
    assert.equal(roleTemplateForAgent(agent), expected[agent.id], `agent ${agent.id} should resolve to ${expected[agent.id]}`);
  }
});

test("the single-agent IELTS coach declares the builder template explicitly (no silent fallback)", () => {
  // The coach performs the work directly, so it is a worker (builder) and self-delegates a
  // task in single-agent mode — a `planner` coordinator would instead answer without a task.
  const tutor = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutor, "ielts-tutor should exist");
  assert.match(tutor.role, /Role template:\s*builder\./);
  assert.equal(roleTemplateForAgent(tutor), "builder");
});
