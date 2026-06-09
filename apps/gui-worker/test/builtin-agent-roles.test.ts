import assert from "node:assert/strict";
import { test } from "node:test";
import { roleTemplateForAgent } from "@suwujs/king-ai/team-workflow";
import { DEFAULT_TEAM_AGENTS, IELTS_WORKFLOW_AGENTS } from "../src/gui-types.js";
import { normalizeAgents } from "../src/gui-runtime.js";

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

test("the IELTS coach is a conversation partner, not a translator that echoes the learner", () => {
  const tutor = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutor, "ielts-tutor should exist");
  assert.match(tutor.role, /chat partner, not a translator/);
  assert.match(tutor.role, /never translate or echo their own sentence back/);
  // It still produces translations/deliverables, but only on explicit request.
  assert.match(tutor.role, /Only write a direct translation or a standalone piece of text when the learner explicitly asks/);
});

test("normalizeAgents refreshes built-in workflow roles from source but keeps the operator's custom role", () => {
  const tutorTemplate = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutorTemplate, "ielts-tutor template should exist");
  const normalized = normalizeAgents([
    // A stale coach role persisted from an older build, plus a user-set model override.
    { id: "ielts-tutor", name: "IELTS Reading & Writing Coach", role: "STALE coach role", engine: "codex", lifecycle: "on-demand", model: "custom-model" },
    // The default operator agent with a role the user customized via agent-config.
    { id: "king-ai-ceo", name: "King AI Helper", role: "Answer in a concise operator voice.", engine: "claude", lifecycle: "disabled" }
  ]);
  const tutor = normalized.find((agent) => agent.id === "ielts-tutor");
  const ceo = normalized.find((agent) => agent.id === "king-ai-ceo");
  // The built-in coach role is refreshed from the source template, not frozen at the stale value.
  assert.equal(tutor?.role, tutorTemplate.role);
  assert.notEqual(tutor?.role, "STALE coach role");
  // Other persisted fields on a built-in agent still survive the refresh.
  assert.equal(tutor?.model, "custom-model");
  // The default operator agent keeps its user-customized role.
  assert.equal(ceo?.role, "Answer in a concise operator voice.");
});
