export type KingRoleTemplateId = "planner" | "builder" | "reviewer" | "tester" | "ops" | "researcher" | "doc-writer" | "summarizer";
export type KingRoutingMode = "one-of-us" | "each" | "review-required" | "human-decision";
export type KingWorkflowObjectType = "initiative" | "task" | "handoff" | "review" | "decision" | "artifact";
export type KingTeamPermissionAction =
  | "assign-task"
  | "claim-task"
  | "create-artifact"
  | "create-decision"
  | "approve-decision"
  | "close-task"
  | "change-scope"
  | "deploy-release"
  | "view-audit"
  | "manage-queue"
  | "view-cost";

export interface KingRoleTemplate {
  id: KingRoleTemplateId;
  name: string;
  responsibility: string;
  defaultRoutingMode: KingRoutingMode;
  capabilityHints: string[];
}

export interface KingTeamRole {
  id: string;
  template: KingRoleTemplateId;
  responsibility: string;
  capabilities: string[];
  handoffPolicy: KingHandoffPolicy;
}

export interface KingHandoffPolicy {
  mode: KingRoutingMode;
  nextRole?: string;
  reviewerRole?: string;
  escalation?: "human" | "coordinator" | "none";
  acceptanceRequired: boolean;
}

export interface KingTeamSpec {
  id: string;
  name: string;
  roles: KingTeamRole[];
  routingPolicy: KingRoutingPolicy;
  permissionPolicy: KingTeamPermissionPolicy;
}

export interface KingRoutingPolicy {
  defaultMode: KingRoutingMode;
  capabilityFirst: boolean;
  reviewRequiredFor: string[];
  humanDecisionFor: string[];
}

export interface KingTeamPermissionRule {
  role: string;
  allow: KingTeamPermissionAction[];
  requireHumanDecision?: KingTeamPermissionAction[];
  requireReviewBy?: string;
}

export interface KingTeamPermissionPolicy {
  defaultDecision: "deny";
  rules: KingTeamPermissionRule[];
}

export interface KingScenarioTemplate {
  id: "repo-takeover" | "bug-investigation" | "product-design" | "release-check" | "research-brief";
  name: string;
  goal: string;
  team: KingTeamSpec;
  acceptance: string[];
  tasks: Array<{
    title: string;
    ownerRole: string;
    reviewerRole?: string;
    dependsOn?: string[];
    acceptance: string[];
  }>;
}

export interface KingAgentRoleLike {
  id?: string;
  name?: string;
  role?: string;
}

export const KING_AI_ROLE_TEMPLATES: KingRoleTemplate[] = [
  {
    id: "planner",
    name: "Planner",
    responsibility: "Break ambiguous goals into ordered work, assign owners, track dependencies, and decide when human input is needed.",
    defaultRoutingMode: "one-of-us",
    capabilityHints: ["planning", "triage", "coordination"]
  },
  {
    id: "builder",
    name: "Builder",
    responsibility: "Implement assigned product, code, document, or analysis changes and report exact artifacts produced.",
    defaultRoutingMode: "one-of-us",
    capabilityHints: ["implementation", "code", "docs"]
  },
  {
    id: "reviewer",
    name: "Reviewer",
    responsibility: "Review scope, risks, correctness, and acceptance evidence before work is marked done.",
    defaultRoutingMode: "review-required",
    capabilityHints: ["review", "quality", "risk"]
  },
  {
    id: "tester",
    name: "Tester",
    responsibility: "Design and run verification, regression, and release-readiness checks with reproducible commands.",
    defaultRoutingMode: "review-required",
    capabilityHints: ["testing", "verification", "regression"]
  },
  {
    id: "ops",
    name: "Ops",
    responsibility: "Handle environment, queue, release, deployment, audit, and operational safety work.",
    defaultRoutingMode: "human-decision",
    capabilityHints: ["ops", "release", "deployment", "audit"]
  },
  {
    id: "researcher",
    name: "Researcher",
    responsibility: "Collect evidence, compare options, preserve source quality, and turn findings into structured artifacts.",
    defaultRoutingMode: "each",
    capabilityHints: ["research", "evidence", "analysis"]
  },
  {
    id: "doc-writer",
    name: "Doc Writer",
    responsibility: "Turn verified decisions and artifacts into user-facing documentation, release notes, and briefs.",
    defaultRoutingMode: "one-of-us",
    capabilityHints: ["documentation", "release-notes", "summary"]
  },
  {
    id: "summarizer",
    name: "Summarizer",
    responsibility: "Close loops with concise status, residual risks, decisions, and artifact links.",
    defaultRoutingMode: "one-of-us",
    capabilityHints: ["summary", "handoff", "status"]
  }
];

export function defaultTeamSpec(id = "default-team", name = "Default Team"): KingTeamSpec {
  const role = (template: KingRoleTemplateId, overrides: Partial<KingTeamRole> = {}): KingTeamRole => {
    const base = roleTemplateById(template);
    return {
      id: overrides.id ?? template,
      template,
      responsibility: overrides.responsibility ?? base.responsibility,
      capabilities: overrides.capabilities ?? base.capabilityHints,
      handoffPolicy: overrides.handoffPolicy ?? {
        mode: base.defaultRoutingMode,
        reviewerRole: template === "builder" ? "reviewer" : undefined,
        escalation: template === "ops" ? "human" : "coordinator",
        acceptanceRequired: template === "builder" || template === "reviewer" || template === "tester"
      }
    };
  };
  return {
    id,
    name,
    roles: [
      role("planner"),
      role("builder"),
      role("reviewer"),
      role("tester"),
      role("ops"),
      role("researcher"),
      role("doc-writer"),
      role("summarizer")
    ],
    routingPolicy: {
      defaultMode: "one-of-us",
      capabilityFirst: true,
      reviewRequiredFor: ["code", "release", "ops", "external"],
      humanDecisionFor: ["production-deploy", "scope-change", "spend", "security-risk"]
    },
    permissionPolicy: {
      defaultDecision: "deny",
      rules: [
        { role: "planner", allow: ["assign-task", "claim-task", "create-artifact", "create-decision", "close-task", "change-scope", "view-audit", "manage-queue", "view-cost"], requireHumanDecision: ["change-scope"] },
        { role: "builder", allow: ["claim-task", "create-artifact"], requireReviewBy: "reviewer" },
        { role: "reviewer", allow: ["claim-task", "create-artifact", "create-decision", "approve-decision", "close-task", "view-audit", "view-cost"] },
        { role: "tester", allow: ["claim-task", "create-artifact", "create-decision", "view-audit"] },
        { role: "ops", allow: ["claim-task", "create-artifact", "create-decision", "approve-decision", "deploy-release", "view-audit", "manage-queue", "view-cost"], requireHumanDecision: ["deploy-release"] },
        { role: "researcher", allow: ["claim-task", "create-artifact", "view-audit"] },
        { role: "doc-writer", allow: ["claim-task", "create-artifact", "view-audit"] },
        { role: "summarizer", allow: ["claim-task", "create-artifact", "view-audit"] }
      ]
    }
  };
}

export function checkTeamPermission(team: KingTeamSpec, role: string, action: KingTeamPermissionAction): {
  decision: "allow" | "deny" | "human-decision";
  rule?: KingTeamPermissionRule;
} {
  const normalizedRole = normalizeTeamRoleId(role);
  const rule = team.permissionPolicy.rules.find((entry) => entry.role === normalizedRole);
  if (!rule || !rule.allow.includes(action)) return { decision: "deny" };
  if (rule.requireHumanDecision?.includes(action)) return { decision: "human-decision", rule };
  return { decision: "allow", rule };
}

export function normalizeTeamRoleId(role: string): string {
  const value = role.trim();
  const aliases: Record<string, string> = {
    ceo: "planner",
    "king-ai-ceo": "planner",
    cto: "reviewer",
    dev: "builder",
    devops: "ops",
    feedback: "researcher",
    marketing: "doc-writer",
    docs: "doc-writer"
  };
  return aliases[value] ?? value;
}

export function roleTemplateForAgent(agent: KingAgentRoleLike): KingRoleTemplateId {
  const text = `${agent.id ?? ""} ${agent.name ?? ""} ${agent.role ?? ""}`.toLowerCase();
  const explicit = text.match(/role template:\s*([a-z-]+)/)?.[1];
  if (explicit && isRoleTemplateId(explicit)) return explicit;
  if (agent.id === "dev") return "builder";
  if (agent.id === "reviewer") return "reviewer";
  if (agent.id === "king-ai-ceo") return "planner";
  if (text.includes("tester")) return "tester";
  if (text.includes("doc-writer") || text.includes("doc writer") || text.includes("documentation")) return "doc-writer";
  if (text.includes("ops") || text.includes("devops") || text.includes("release")) return "ops";
  if (text.includes("researcher") || text.includes("research")) return "researcher";
  if (text.includes("reviewer")) return "reviewer";
  if (text.includes("builder") || text.includes("implement")) return "builder";
  if (text.includes("planner") || text.includes("ceo") || text.includes("coordinate")) return "planner";
  return "builder";
}

export function requiredCapabilitiesForText(text: string): string[] {
  const value = text.toLowerCase();
  if (/\b(test|verify|verification|regression|qa)\b/.test(value)) return ["testing", "verification"];
  if (/\b(release|deploy|queue|approval|audit|ops)\b/.test(value)) return ["ops", "release", "audit"];
  if (/\b(research|compare|brief|market|source|evidence)\b/.test(value)) return ["research", "evidence"];
  if (/\b(doc|docs|readme|release note|write|summary)\b/.test(value)) return ["documentation", "summary"];
  return ["implementation", "code"];
}

export function roleTemplateById(id: KingRoleTemplateId): KingRoleTemplate {
  const template = KING_AI_ROLE_TEMPLATES.find((entry) => entry.id === id);
  if (!template) throw new Error(`unknown role template: ${id}`);
  return template;
}

function isRoleTemplateId(value: string): value is KingRoleTemplateId {
  return KING_AI_ROLE_TEMPLATES.some((template) => template.id === value);
}

export function scenarioTemplate(id: KingScenarioTemplate["id"]): KingScenarioTemplate {
  const team = defaultTeamSpec(`${id}-team`, `${titleCase(id)} Team`);
  const commonAcceptance = [
    "Every task has an owner role and acceptance evidence.",
    "Review-required work has a reviewer role before completion.",
    "Human decisions are represented as decision workflow objects."
  ];
  const scenarios: Record<KingScenarioTemplate["id"], KingScenarioTemplate> = {
    "repo-takeover": {
      id,
      name: "Repo Takeover",
      goal: "Understand a repository, establish safe operating boundaries, and produce a takeover-ready plan.",
      team,
      acceptance: [...commonAcceptance, "Repository structure, build/test commands, and risk areas are captured."],
      tasks: [
        { title: "Map repository structure and ownership boundaries", ownerRole: "researcher", reviewerRole: "planner", acceptance: ["Key modules and commands are documented."] },
        { title: "Create takeover backlog and capsule boundaries", ownerRole: "planner", reviewerRole: "reviewer", dependsOn: ["task-1"], acceptance: ["Backlog has ordered tasks and scoped capsules."] },
        { title: "Verify build and test entrypoints", ownerRole: "tester", reviewerRole: "ops", dependsOn: ["task-1"], acceptance: ["Verification commands and failures are recorded."] }
      ]
    },
    "bug-investigation": {
      id,
      name: "Bug Investigation",
      goal: "Find root cause, propose a focused fix, verify behavior, and produce a concise incident artifact.",
      team,
      acceptance: [...commonAcceptance, "Root cause is linked to code/runtime evidence."],
      tasks: [
        { title: "Reproduce and isolate symptom", ownerRole: "tester", reviewerRole: "researcher", acceptance: ["Reproduction or strongest available evidence is recorded."] },
        { title: "Trace root cause and candidate fix", ownerRole: "builder", reviewerRole: "reviewer", dependsOn: ["task-1"], acceptance: ["Cause and changed files are identified."] },
        { title: "Verify fix and summarize residual risk", ownerRole: "reviewer", reviewerRole: "planner", dependsOn: ["task-2"], acceptance: ["Regression evidence and risk summary are recorded."] }
      ]
    },
    "product-design": {
      id,
      name: "Product Design",
      goal: "Turn a product idea into roles, user flows, acceptance criteria, and implementation-ready artifacts.",
      team,
      acceptance: [...commonAcceptance, "Design decisions are explicit and unresolved choices are escalated."],
      tasks: [
        { title: "Research user goals and competing workflows", ownerRole: "researcher", reviewerRole: "planner", acceptance: ["Insights and assumptions are captured."] },
        { title: "Define user flow and acceptance criteria", ownerRole: "planner", reviewerRole: "reviewer", dependsOn: ["task-1"], acceptance: ["Flow, scope, and non-goals are written."] },
        { title: "Draft implementation-facing design artifact", ownerRole: "doc-writer", reviewerRole: "builder", dependsOn: ["task-2"], acceptance: ["Artifact is ready for build planning."] }
      ]
    },
    "release-check": {
      id,
      name: "Release Check",
      goal: "Validate readiness for release with testing, risk review, approvals, and release notes.",
      team,
      acceptance: [...commonAcceptance, "Release decision is represented as an approval or decision object."],
      tasks: [
        { title: "Run release verification checklist", ownerRole: "tester", reviewerRole: "ops", acceptance: ["Commands, pass/fail state, and gaps are recorded."] },
        { title: "Review operational and regression risk", ownerRole: "reviewer", reviewerRole: "ops", dependsOn: ["task-1"], acceptance: ["Risks and mitigations are recorded."] },
        { title: "Prepare release notes and human decision", ownerRole: "doc-writer", reviewerRole: "planner", dependsOn: ["task-2"], acceptance: ["Release notes and approval question exist."] }
      ]
    },
    "research-brief": {
      id,
      name: "Research Brief",
      goal: "Produce a sourced, confidence-scored brief with decisions, artifacts, and follow-up tasks.",
      team,
      acceptance: [...commonAcceptance, "Claims include source quality and confidence."],
      tasks: [
        { title: "Collect evidence and competing viewpoints", ownerRole: "researcher", reviewerRole: "reviewer", acceptance: ["Artifacts include source and confidence."] },
        { title: "Synthesize brief and recommendations", ownerRole: "doc-writer", reviewerRole: "planner", dependsOn: ["task-1"], acceptance: ["Brief includes recommendation and caveats."] },
        { title: "Record decision points and follow-up tasks", ownerRole: "planner", reviewerRole: "reviewer", dependsOn: ["task-2"], acceptance: ["Open decisions and next tasks are explicit."] }
      ]
    }
  };
  return scenarios[id];
}

function titleCase(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
