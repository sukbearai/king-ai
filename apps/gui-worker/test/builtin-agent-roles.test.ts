import assert from "node:assert/strict";
import { test } from "node:test";
import { roleTemplateForAgent } from "@suwujs/king-ai/team-workflow";
import { DEFAULT_TEAM_AGENTS, IELTS_WORKFLOW_AGENTS } from "../src/gui-types.js";
import { normalizeAgents, normalizeWorkflowAgentDefinitions } from "../src/gui-runtime.js";

const TEMPLATE_MARKER = /Role template:\s*[a-z-]+\./;

test("every built-in software-dev agent declares an explicit role template", () => {
  const expected: Record<string, string> = { dev: "builder" };
  assert.deepEqual(
    DEFAULT_TEAM_AGENTS.map((agent) => agent.id),
    Object.keys(expected),
  );
  for (const agent of DEFAULT_TEAM_AGENTS) {
    assert.match(agent.role, TEMPLATE_MARKER, `agent ${agent.id} should carry a Role template marker`);
    assert.equal(
      roleTemplateForAgent(agent),
      expected[agent.id],
      `agent ${agent.id} should resolve to ${expected[agent.id]}`,
    );
  }
});

test("the single-agent IELTS coach declares the builder template explicitly (no silent fallback)", () => {
  // The coach performs the work directly, so it is a worker (builder) and self-delegates a
  // task in single-agent mode — a `planner` coordinator would instead answer without a task.
  const tutor = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutor, "ielts-tutor should exist");
  assert.match(tutor.role, /Role template:\s*builder\./);
  assert.equal(roleTemplateForAgent(tutor), "builder");
  assert.equal(tutor.structuredReply?.bodyField, "replyMarkdown");
  assert.equal(tutor.structuredReply?.trailingJsonField, "wordCards");
  assert.equal(tutor.structuredReply?.trailingJsonLabel, "WordCards");
  const schema = tutor.structuredReply?.outputSchema as { required?: string[]; additionalProperties?: boolean };
  assert.deepEqual(schema.required, ["replyMarkdown", "wordCards"]);
  assert.equal(schema.additionalProperties, false);
  assert.match(tutor.role, /structured reply delivery is active/);
});

test("the IELTS coach is a conversation partner, not a translator that echoes the learner", () => {
  const tutor = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutor, "ielts-tutor should exist");
  assert.match(tutor.role, /chat partner, not a translator/);
  assert.match(tutor.role, /never translate or echo their own sentence back/);
  // It still produces translations/deliverables, but only on explicit request.
  assert.match(
    tutor.role,
    /Only write a direct translation or a standalone piece of text when the learner explicitly asks/,
  );
});

test("normalizeAgents keeps only the two workflow agents", () => {
  const tutorTemplate = IELTS_WORKFLOW_AGENTS.find((agent) => agent.id === "ielts-tutor");
  assert.ok(tutorTemplate, "ielts-tutor template should exist");
  const normalized = normalizeAgents([
    // A stale coach role persisted from an older build, plus a user-set model override.
    {
      id: "ielts-tutor",
      name: "IELTS Reading & Writing Coach",
      role: "STALE coach role",
      engine: "codex",
      lifecycle: "on-demand",
      model: "custom-model",
      structuredReply: {
        outputSchema: { type: "string" },
        bodyField: "staleBody",
      },
    },
    // A retired default operator from the previous software-dev roster.
    {
      id: "king-ai-ceo",
      name: "King AI Helper",
      role: "Answer in a concise operator voice.",
      engine: "claude",
      lifecycle: "disabled",
    },
    // The current default operator with a role the user customized via agent-config.
    {
      id: "dev",
      name: "Dev",
      role: "Answer in a concise operator voice.",
      engine: "claude",
      lifecycle: "disabled",
    },
    { id: "tester", name: "Tester", role: "Legacy tester.", engine: "codex", lifecycle: "on-demand" },
    {
      id: "ielts-vocab-coach",
      name: "IELTS Vocabulary Coach",
      role: "Custom coach.",
      engine: "codex",
      lifecycle: "on-demand",
    },
  ]);
  const tutor = normalized.find((agent) => agent.id === "ielts-tutor");
  const dev = normalized.find((agent) => agent.id === "dev");
  assert.deepEqual([...normalized.map((agent) => agent.id)].sort(), ["dev", "ielts-tutor"]);
  // The built-in coach role is refreshed from the source template, not frozen at the stale value.
  assert.equal(tutor?.role, tutorTemplate.role);
  assert.notEqual(tutor?.role, "STALE coach role");
  // Other persisted fields on a built-in agent still survive the refresh.
  assert.equal(tutor?.model, "custom-model");
  assert.deepEqual(tutor?.structuredReply, tutorTemplate.structuredReply);
  assert.notEqual(tutor?.structuredReply?.bodyField, "staleBody");
  // The default operator agent keeps its user-customized role.
  assert.equal(dev?.role, "Answer in a concise operator voice.");
});

test("normalizeAgents refreshes the retired built-in Dev role", () => {
  const normalized = normalizeAgents([
    {
      id: "dev",
      name: "Dev",
      role: "Implement only assigned tasks. Make concrete changes, run focused verification, report files changed and command results, then mark the task done so it can be reviewed or returned to King AI CEO. Role template: builder.",
      engine: "grok",
      lifecycle: "on-demand",
    },
  ]);
  assert.match(normalized.find((agent) => agent.id === "dev")?.role ?? "", /do not delegate/);
});

test("normalizeWorkflowAgentDefinitions keeps non-empty reasoning effort only", () => {
  const normalized = normalizeWorkflowAgentDefinitions([
    {
      id: "dev",
      name: "Dev",
      role: "Build.",
      engine: "grok",
      lifecycle: "on-demand",
      model: " grok-4 ",
      fastModel: " grok-fast ",
      reasoningEffort: " low ",
    },
    {
      id: "reviewer",
      name: "Reviewer",
      role: "Review.",
      engine: "grok",
      lifecycle: "on-demand",
      reasoningEffort: "   ",
    },
  ]);

  assert.equal(normalized[0]?.reasoningEffort, "low");
  assert.equal(normalized[1]?.reasoningEffort, undefined);
});
