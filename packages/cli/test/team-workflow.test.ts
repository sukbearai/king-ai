import assert from "node:assert/strict";
import { test } from "node:test";
import { KING_AI_ROLE_TEMPLATES, checkTeamPermission, defaultTeamSpec, hasExplicitImplementationIntent, isPlannerGuidanceText, normalizeTeamRoleId, requiredCapabilitiesForText, roleTemplateForAgent, scenarioTemplate } from "../src/team-workflow.js";

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
  assert.deepEqual(requiredCapabilitiesForText("所有人在回个 1"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("everyone roll call reply with 1"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("你在？"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("轮流报数"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("team count in order"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("build the feature"), ["implementation", "code"]);
  assert.deepEqual(requiredCapabilitiesForText("接下来做什么"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("还没改完？"), ["coordination"]);
  assert.deepEqual(requiredCapabilitiesForText("你推荐个方案"), ["coordination"]);
});

test("planner guidance text stays out of builder routing", () => {
  assert.equal(isPlannerGuidanceText("接下来做什么"), true);
  assert.equal(isPlannerGuidanceText("继续下一步"), true);
  assert.equal(isPlannerGuidanceText("还没改完？"), true);
  assert.equal(isPlannerGuidanceText("改造完了？"), true);
  assert.equal(isPlannerGuidanceText("你推荐个方案"), true);
  assert.equal(isPlannerGuidanceText("哪些任务啊？"), true);
  assert.equal(isPlannerGuidanceText("怎么验证要提交发布吗"), true);
  assert.equal(isPlannerGuidanceText("是不是有问题?"), true);
  assert.equal(isPlannerGuidanceText("Go Phase 2"), true);
  assert.equal(isPlannerGuidanceText("请团队实现多角色协作"), false);
  assert.equal(hasExplicitImplementationIntent("请团队实现多角色协作"), true);
  assert.equal(hasExplicitImplementationIntent("@dev roll call reply"), true);
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
