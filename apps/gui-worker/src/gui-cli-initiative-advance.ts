import type { GuiCliExecutionPlan, GuiCliPlannedTask } from "./gui-cli-plan.js";
import type { GuiCliInitiative } from "./gui-cli-initiative.js";
import type { GuiCliDoc } from "./gui-cli-doc.js";
import type { GuiCliContextEntry } from "./gui-cli-context.js";

export const VISION_PLAN_TITLE = "King AI Vision Evolution Plan";

export const VISION_PLAN_BODY = `# King AI Vision Evolution Plan

Approved 2026-06-15 (@suk.bear Go Phase 1).

## Verdict
Long-horizon execution + coordination substrate already exists (Initiative→Capsule→Task DAG, recall, plan apply, eval).
The one real gap: no goal-gap → next-step self-driver. Advancement is event-driven (human message → task), not vision-driven.

## Phase 1 (NOW)
- \`king-ai initiative advance <id>\` — read goal + linked tasks/capsules, emit gap context, optionally apply ExecutionPlan via plan apply
- Explicit trigger only; no wake/routing changes in v1
- Acceptance: on a real initiative, generated task DAG ships without human edits

## Phase 2 (later)
- Capsule execution via optional orca adapter (worktree + terminal spawn)
- Keep orca optional; do not clash with king-ai worktree.ts

## Phase 3 (later)
- Idle self-drive after Phase 1 acceptance passes

## Do NOT (now)
- Auto-create initiative from chat intent detection
- WorkspaceProvider abstraction
- Embed full VAS stack
- GUI vision tree (YAGNI)
`;

export type InitiativeLinkedTask = {
  id: string;
  title: string;
  status: string;
  initiativeId?: string;
  dependsOn?: string[];
};

export type InitiativeLinkedCapsule = {
  id: string;
  status: string;
  goal?: string;
  initiativeId?: string;
};

export type InitiativeGapReport = {
  initiativeId: string;
  title: string;
  goal: string;
  status: string;
  taskCounts: Record<string, number>;
  openTaskCount: number;
  capsuleCount: number;
  openCapsuleCount: number;
  gaps: string[];
  openTasks: Array<{ id: string; title: string; status: string }>;
  doneTasks: Array<{ id: string; title: string }>;
};

const OPEN_TASK_STATUSES = new Set(["pending", "assigned", "in_progress", "review", "blocked"]);

export function isOpenTaskStatus(status: string): boolean {
  return OPEN_TASK_STATUSES.has(status);
}

export function buildInitiativeGapReport<
  I extends GuiCliInitiative,
  T extends InitiativeLinkedTask,
  C extends InitiativeLinkedCapsule
>(initiative: I, tasks: T[], capsules: C[]): InitiativeGapReport {
  const linkedTasks = tasks.filter((task) => task.initiativeId === initiative.id);
  const linkedCapsules = capsules.filter((capsule) => capsule.initiativeId === initiative.id);
  const taskCounts: Record<string, number> = {};
  for (const task of linkedTasks) {
    taskCounts[task.status] = (taskCounts[task.status] || 0) + 1;
  }
  const openTasks = linkedTasks
    .filter((task) => isOpenTaskStatus(task.status))
    .map((task) => ({ id: task.id, title: task.title, status: task.status }));
  const doneTasks = linkedTasks
    .filter((task) => task.status === "done")
    .map((task) => ({ id: task.id, title: task.title }));
  const openCapsuleCount = linkedCapsules.filter((capsule) => capsule.status === "open" || capsule.status === "in_review").length;
  const gaps: string[] = [];
  if (initiative.status !== "active") gaps.push(`initiative status is ${initiative.status}, not active`);
  if (linkedTasks.length === 0) gaps.push("no tasks linked to this initiative");
  if (openTasks.length > 0) gaps.push(`${openTasks.length} open task(s) still in flight`);
  if (linkedTasks.length > 0 && openTasks.length === 0 && initiative.status === "active") {
    gaps.push("all linked tasks are closed; goal may need next-step decomposition");
  }
  if (linkedCapsules.length === 0 && linkedTasks.length === 0) {
    gaps.push("no capsules or tasks materialized yet");
  }
  return {
    initiativeId: initiative.id,
    title: initiative.title,
    goal: initiative.goal,
    status: initiative.status,
    taskCounts,
    openTaskCount: openTasks.length,
    capsuleCount: linkedCapsules.length,
    openCapsuleCount,
    gaps,
    openTasks,
    doneTasks
  };
}

export function formatInitiativeGapReport(report: InitiativeGapReport): string {
  const lines = [
    `initiative ${report.initiativeId}: "${report.title}" [${report.status}]`,
    `goal: ${report.goal}`,
    `tasks: ${Object.entries(report.taskCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
    `capsules: total=${report.capsuleCount} open=${report.openCapsuleCount}`,
    `gaps:`,
    ...(report.gaps.length ? report.gaps.map((gap) => `- ${gap}`) : ["- none detected"])
  ];
  if (report.openTasks.length) {
    lines.push("open tasks:");
    for (const task of report.openTasks) lines.push(`- ${task.id} [${task.status}] ${task.title}`);
  }
  if (report.doneTasks.length) {
    lines.push("done tasks:");
    for (const task of report.doneTasks) lines.push(`- ${task.id} ${task.title}`);
  }
  return lines.join("\n");
}

export function buildAutoExecutionPlan(initiative: GuiCliInitiative, report: InitiativeGapReport): GuiCliExecutionPlan | undefined {
  if (report.openTaskCount > 0) return undefined;
  if (initiative.status !== "active") return undefined;
  const optionId = `advance-${initiative.id.slice(0, 24)}`;
  const scopePaths = ["apps/gui-worker/src"];
  let tasks: GuiCliPlannedTask[];
  if (report.doneTasks.length === 0 && report.openTaskCount === 0) {
    tasks = [
      {
        title: `Scope goal: ${initiative.title}`,
        description: `Analyze initiative goal and produce a concrete execution breakdown.\nGoal: ${initiative.goal}`,
        priority: initiative.priority || 5,
        dependencies: [],
        scope: { paths: scopePaths }
      },
      {
        title: `Implement first milestone for ${initiative.title}`,
        description: `Execute the first scoped change toward: ${initiative.goal}`,
        priority: Math.max(1, (initiative.priority || 5) - 1),
        dependencies: [`Scope goal: ${initiative.title}`],
        scope: { paths: scopePaths }
      }
    ];
  } else {
    tasks = [
      {
        title: `Next step: ${initiative.title}`,
        description: `Continue initiative after ${report.doneTasks.length} completed task(s).\nGoal: ${initiative.goal}`,
        priority: initiative.priority || 5,
        dependencies: [],
        scope: { paths: scopePaths }
      }
    ];
  }
  return {
    optionId,
    totalEstimatedTokens: tasks.length * 4000,
    tasks
  };
}

export type RunInitiativeAdvanceDeps<
  S extends {
    initiatives: GuiCliInitiative[];
    tasks: InitiativeLinkedTask[];
    capsules: InitiativeLinkedCapsule[];
  },
  I extends GuiCliInitiative
> = {
  defaultAgentId: string;
  findInitiative: (state: S, id: string | undefined) => I | undefined;
  readOption: (args: string[], flag: string) => string | undefined;
  readBooleanOption: (args: string[], flag: string) => boolean | undefined;
  parseExecutionPlan: (raw: string) => GuiCliExecutionPlan;
  applyExecutionPlan: (
    state: S,
    plan: GuiCliExecutionPlan,
    options: { assign?: string; initiativeId: string }
  ) => string;
};

export function runInitiativeAdvanceCommand<
  S extends {
    initiatives: GuiCliInitiative[];
    tasks: InitiativeLinkedTask[];
    capsules: InitiativeLinkedCapsule[];
  },
  I extends GuiCliInitiative
>(state: S, args: string[], deps: RunInitiativeAdvanceDeps<S, I>): string {
  const initiativeId = args[0];
  if (!initiativeId || initiativeId.startsWith("--")) {
    return "usage: king-ai initiative advance <id> [--dry-run] [--auto] [--apply '<json plan>'] [--assign agent-id]";
  }
  const initiative = deps.findInitiative(state, initiativeId);
  if (!initiative) return `initiative not found: ${initiativeId}`;
  const report = buildInitiativeGapReport(initiative, state.tasks, state.capsules);
  const dryRun = deps.readBooleanOption(args, "--dry-run") ?? false;
  const assign = deps.readOption(args, "--assign") || deps.readOption(args, "--assignee") || deps.defaultAgentId;
  const applyRaw = deps.readOption(args, "--apply");
  const auto = deps.readBooleanOption(args, "--auto") ?? false;
  initiative.updated_at = Date.now();

  if (applyRaw) {
    let plan: GuiCliExecutionPlan;
    try {
      plan = deps.parseExecutionPlan(applyRaw);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (dryRun) {
      return [
        formatInitiativeGapReport(report),
        "",
        `dry-run: would apply plan ${plan.optionId} (${plan.tasks.length} task(s)) assign=${assign}`
      ].join("\n");
    }
    const applied = deps.applyExecutionPlan(state, plan, { assign, initiativeId: initiative.id });
    return [formatInitiativeGapReport(report), "", applied].join("\n");
  }

  if (auto) {
    const plan = buildAutoExecutionPlan(initiative, report);
    if (!plan) {
      return [
        formatInitiativeGapReport(report),
        "",
        "auto: skipped (open tasks in flight or initiative not active)"
      ].join("\n");
    }
    if (dryRun) {
      return [
        formatInitiativeGapReport(report),
        "",
        `auto plan ${plan.optionId}: ${plan.tasks.length} task(s)`,
        ...plan.tasks.map((task) => `- P${task.priority} ${task.title} after=${task.dependencies.join(",") || "none"}`)
      ].join("\n");
    }
    const applied = deps.applyExecutionPlan(state, plan, { assign, initiativeId: initiative.id });
    return [formatInitiativeGapReport(report), "", applied].join("\n");
  }

  return formatInitiativeGapReport(report);
}

export type RunInitiativePersistDeps<
  S extends {
    initiatives: GuiCliInitiative[];
    docs: GuiCliDoc[];
    context: GuiCliContextEntry[];
  },
  I extends GuiCliInitiative
> = {
  defaultAgentId: string;
  actorId: string;
  findInitiative: (state: S, id: string | undefined) => I | undefined;
  readOption: (args: string[], flag: string) => string | undefined;
  readBooleanOption: (args: string[], flag: string) => boolean | undefined;
  normalizePriority: (value: string | undefined) => number;
};

export function runInitiativePersistCommand<
  S extends {
    initiatives: GuiCliInitiative[];
    docs: GuiCliDoc[];
    context: GuiCliContextEntry[];
  },
  I extends GuiCliInitiative
>(state: S, args: string[], deps: RunInitiativePersistDeps<S, I>): string {
  const title = deps.readOption(args, "--title") || "King AI Vision-Driven Evolution";
  const goal = deps.readOption(args, "--goal")
    || "Ship initiative advance (Phase 1) and validate vision-driven task decomposition on real initiatives.";
  const initiativeId = deps.readOption(args, "--initiative");
  let initiative = initiativeId ? deps.findInitiative(state, initiativeId) : undefined;
  if (initiativeId && !initiative) return `initiative not found: ${initiativeId}`;
  const createInitiative = deps.readBooleanOption(args, "--create") ?? !initiativeId;
  if (!initiative && createInitiative) {
    const now = Date.now();
    initiative = {
      id: `initiative-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      goal,
      summary: "Vision evolution Phase 1",
      status: "active",
      priority: deps.normalizePriority(deps.readOption(args, "--priority") || "7"),
      sources: ["vision-plan-persist"],
      agentId: deps.readOption(args, "--agent") || deps.defaultAgentId,
      created_at: now,
      updated_at: now
    } as I;
    state.initiatives.push(initiative);
  }
  const existingDoc = state.docs.find((doc) => doc.title === VISION_PLAN_TITLE);
  const doc: GuiCliDoc = existingDoc ?? {
    id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: VISION_PLAN_TITLE,
    body: "",
    created_at: Date.now()
  };
  if (!existingDoc) state.docs.push(doc);
  doc.body = VISION_PLAN_BODY;
  const contextRows: Array<{ key: string; value: string }> = [
    { key: "vision.plan.docId", value: doc.id },
    { key: "vision.plan.phase", value: "1" },
    { key: "vision.plan.status", value: "active" },
    { key: "vision.plan.approvedAt", value: "2026-06-15" }
  ];
  if (initiative) contextRows.push({ key: "vision.plan.initiativeId", value: initiative.id });
  const now = Date.now();
  for (const row of contextRows) {
    const existing = state.context.find((entry) => entry.key === row.key);
    if (existing) {
      existing.value = row.value;
      existing.updatedBy = deps.actorId;
      existing.updatedAt = now;
    } else {
      state.context.push({ key: row.key, value: row.value, updatedBy: deps.actorId, updatedAt: now });
    }
  }
  return [
    `vision plan persisted doc=${doc.id}${initiative ? ` initiative=${initiative.id}` : ""}`,
    `context: ${contextRows.map((row) => row.key).join(", ")}`
  ].join("\n");
}