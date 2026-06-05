import assert from "node:assert/strict";
import { test } from "node:test";
import { KING_AI_ROLE_TEMPLATES, checkTeamPermission, defaultTeamSpec, normalizeTeamRoleId, requiredCapabilitiesForText, roleTemplateForAgent, scenarioTemplate } from "../src/team-workflow.js";

test("default team exposes structured role templates and routing policy", () => {
  const team = defaultTeamSpec();
  assert.deepEqual(KING_AI_ROLE_TEMPLATES.map((role) => role.id), ["planner", "builder", "reviewer", "tester", "ops", "researcher", "doc-writer", "summarizer"]);
  assert.equal(team.routingPolicy.capabilityFirst, true);
  assert.equal(team.routingPolicy.humanDecisionFor.includes("production-deploy"), true);
  assert.equal(team.permissionPolicy.defaultDecision, "deny");
  assert.equal(team.permissionPolicy.rules.some((rule) => rule.role === "ops" && rule.allow.includes("deploy-release")), true);
  assert.equal(team.roles.find((role) => role.template === "builder")?.handoffPolicy.reviewerRole, "reviewer");
  assert.equal(team.roles.every((role) => role.responsibility.length > 20), true);
  // The default team assembles every role template, including the loop-closing summarizer.
  assert.equal(team.roles.length, KING_AI_ROLE_TEMPLATES.length);
  assert.equal(team.roles.some((role) => role.template === "summarizer"), true);
  assert.equal(team.permissionPolicy.rules.some((rule) => rule.role === "summarizer"), true);
});

test("team permission policy maps role actions to runtime decisions", () => {
  const team = defaultTeamSpec();
  assert.equal(checkTeamPermission(team, "builder", "create-artifact").decision, "allow");
  assert.equal(checkTeamPermission(team, "dev", "create-artifact").decision, "allow");
  assert.equal(checkTeamPermission(team, "cto", "approve-decision").decision, "allow");
  assert.equal(checkTeamPermission(team, "builder", "deploy-release").decision, "deny");
  assert.equal(checkTeamPermission(team, "ops", "deploy-release").decision, "human-decision");
  assert.equal(checkTeamPermission(team, "unknown", "claim-task").decision, "deny");
  assert.equal(normalizeTeamRoleId("king-ai-ceo"), "planner");
  assert.equal(normalizeTeamRoleId("marketing"), "doc-writer");
});

test("shared collaboration semantics classify agents and request capabilities", () => {
  assert.equal(roleTemplateForAgent({ id: "king-ai-ceo", name: "King AI CEO", role: "Coordinate work" }), "planner");
  assert.equal(roleTemplateForAgent({ id: "dev", name: "Dev", role: "Implement work" }), "builder");
  assert.equal(roleTemplateForAgent({ id: "custom", name: "QA", role: "Role template: tester. Verify releases." }), "tester");
  assert.equal(roleTemplateForAgent({ id: "writer", name: "Writer", role: "Documentation and release notes" }), "doc-writer");

  assert.deepEqual(requiredCapabilitiesForText("run regression verification tests"), ["testing", "verification"]);
  assert.deepEqual(requiredCapabilitiesForText("research competitors and source evidence"), ["research", "evidence"]);
  assert.deepEqual(requiredCapabilitiesForText("prepare release approval and audit queue"), ["ops", "release", "audit"]);
  assert.deepEqual(requiredCapabilitiesForText("write docs and a summary"), ["documentation", "summary"]);
  assert.deepEqual(requiredCapabilitiesForText("build the feature"), ["implementation", "code"]);
});

test("built-in team scenarios include roles tasks and acceptance", () => {
  const ids = ["repo-takeover", "bug-investigation", "product-design", "release-check", "research-brief"] as const;
  for (const id of ids) {
    const scenario = scenarioTemplate(id);
    assert.equal(scenario.id, id);
    assert.equal(scenario.team.roles.length >= 7, true);
    assert.equal(scenario.acceptance.length >= 4, true);
    assert.equal(scenario.tasks.length >= 3, true);
    assert.equal(scenario.tasks.every((task) => task.ownerRole && task.acceptance.length > 0), true);
    assert.equal(scenario.tasks.some((task) => task.reviewerRole), true);
  }
});
