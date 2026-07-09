import type { createGuiTaskDraft } from "./workflow-state.js";

export type GuiCliPlannedTask = {
  title: string;
  description?: string;
  priority: number;
  dependencies: string[];
  scope: { paths: string[]; patterns?: string[] };
};

export type GuiCliExecutionPlan = {
  optionId: string;
  totalEstimatedTokens: number;
  tasks: GuiCliPlannedTask[];
};

export type GuiCliPlanTask = {
  id: string;
  title: string;
  dependsOn?: string[];
};

export type RunPlanCommandDeps<S extends { tasks: GuiCliPlanTask[] }, T extends GuiCliPlanTask> = {
  defaultAgentId: string;
  parseExecutionPlan: (raw: string) => GuiCliExecutionPlan;
  readOption: (args: string[], flag: string) => string | undefined;
  createTask: (input: Parameters<typeof createGuiTaskDraft>[0]) => T;
};

export function runPlanCommand<S extends { tasks: GuiCliPlanTask[] }, T extends GuiCliPlanTask>(
  state: S,
  args: string[],
  deps: RunPlanCommandDeps<S, T>,
): string {
  const cmd = args[0] || "parse";
  if (cmd !== "parse" && cmd !== "apply") {
    return "usage: king-ai plan parse|apply '<json plan>' [--assign agent-id] [--initiative id]";
  }
  let plan: GuiCliExecutionPlan;
  try {
    plan = deps.parseExecutionPlan(args.slice(1).find((arg) => !arg.startsWith("--")) || "");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (cmd === "parse") {
    return [
      `plan ${plan.optionId}: ${plan.tasks.length} task(s), estimatedTokens=${plan.totalEstimatedTokens}`,
      ...plan.tasks.map(
        (task) =>
          `- P${task.priority} ${task.title} paths=${task.scope.paths.join(",") || "none"} after=${task.dependencies.join(",") || "none"}`,
      ),
    ].join("\n");
  }
  const assign = deps.readOption(args, "--assign") || deps.readOption(args, "--assignee") || deps.defaultAgentId;
  const initiativeId = deps.readOption(args, "--initiative");
  const byTitle = new Map<string, string>();
  const created: T[] = [];
  for (const planned of plan.tasks) {
    const task = deps.createTask({
      title: planned.title,
      description: planned.description,
      status: assign ? "assigned" : "pending",
      assignee: assign,
      priority: planned.priority,
      dependsOn: planned.dependencies.map((title) => byTitle.get(title) || title).filter(Boolean),
      initiativeId,
      scope: planned.scope,
      executionProfile: `plan:${plan.optionId}`,
    });
    state.tasks.push(task);
    created.push(task);
    byTitle.set(planned.title, task.id);
  }
  return [
    `plan applied ${plan.optionId}: ${created.length} task(s) created`,
    ...created.map(
      (task) =>
        `- ${task.id} "${task.title}"${task.dependsOn?.length ? ` after=${task.dependsOn.map((id) => id.slice(0, 10)).join(",")}` : ""}`,
    ),
  ].join("\n");
}
