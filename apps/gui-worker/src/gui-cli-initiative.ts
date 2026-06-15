import type { GuiCliContextEntry } from "./gui-cli-context.js";
import type { GuiCliDoc } from "./gui-cli-doc.js";
import type { GuiCliExecutionPlan } from "./gui-cli-plan.js";
import {
  runInitiativeAdvanceCommand,
  runInitiativePersistCommand,
  type InitiativeLinkedCapsule,
  type InitiativeLinkedTask
} from "./gui-cli-initiative-advance.js";

export type GuiCliInitiativeStatus = "active" | "paused" | "completed" | "abandoned";

export type GuiCliInitiative = {
  id: string;
  title: string;
  goal: string;
  summary?: string;
  status: GuiCliInitiativeStatus | string;
  priority: number;
  sources?: string[];
  agentId?: string;
  created_at: number;
  updated_at: number;
};

export type RunInitiativeCommandDeps<
  S extends {
    initiatives: GuiCliInitiative[];
    tasks: InitiativeLinkedTask[];
    capsules: InitiativeLinkedCapsule[];
    docs: GuiCliDoc[];
    context: GuiCliContextEntry[];
  },
  I extends GuiCliInitiative
> = {
  defaultAgentId: string;
  actorId?: string;
  findInitiative: (state: S, id: string | undefined) => I | undefined;
  formatInitiativeLine: (state: S, initiative: I) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  readBooleanOption: (args: string[], flag: string) => boolean | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
  parseCsvOption: (args: string[], flag: string) => string[] | undefined;
  normalizePriority: (value: string | undefined) => number;
  isInitiativeStatus: (value: string) => value is GuiCliInitiativeStatus;
  parseExecutionPlan: (raw: string) => GuiCliExecutionPlan;
  applyExecutionPlan: (
    state: S,
    plan: GuiCliExecutionPlan,
    options: { assign?: string; initiativeId: string }
  ) => string;
};

export function runInitiativeCommand<
  S extends {
    initiatives: GuiCliInitiative[];
    tasks: InitiativeLinkedTask[];
    capsules: InitiativeLinkedCapsule[];
    docs: GuiCliDoc[];
    context: GuiCliContextEntry[];
  },
  I extends GuiCliInitiative
>(state: S, args: string[], deps: RunInitiativeCommandDeps<S, I>): string {
  const cmd = args[0] || "list";
  if (cmd === "advance") {
    return runInitiativeAdvanceCommand(state, args.slice(1), deps);
  }
  if (cmd === "persist") {
    return runInitiativePersistCommand(state, args.slice(1), {
      defaultAgentId: deps.defaultAgentId,
      actorId: deps.actorId || deps.defaultAgentId,
      findInitiative: deps.findInitiative,
      readOption: deps.readOption,
      readBooleanOption: deps.readBooleanOption,
      normalizePriority: deps.normalizePriority
    });
  }
  if (cmd === "list") {
    const status = deps.readOption(args, "--status");
    const initiatives = state.initiatives.filter((initiative) => !status || initiative.status === status) as I[];
    if (initiatives.length === 0) return "No initiatives found.";
    return initiatives.map((initiative) => deps.formatInitiativeLine(state, initiative)).join("\n") + `\n\n${initiatives.length} initiative(s)`;
  }
  if (cmd === "get") {
    const initiative = deps.findInitiative(state, args[1]);
    return initiative ? JSON.stringify({
      ...initiative,
      taskCount: state.tasks.filter((task) => task.initiativeId === initiative.id).length,
      capsuleCount: state.capsules.filter((capsule) => capsule.initiativeId === initiative.id).length
    }, null, 2) : `initiative not found: ${args[1] || ""}`;
  }
  if (cmd === "create") {
    const title = deps.stripOptions(args.slice(1), ["--goal", "--summary", "--priority", "--source", "--status", "--agent"]).join(" ").trim();
    const goal = deps.readOption(args, "--goal");
    const status = deps.readOption(args, "--status") || "active";
    if (!title || !goal) {
      return "usage: king-ai initiative create <title> --goal <goal> [--summary text] [--priority 1-10] [--source a,b]";
    }
    if (!deps.isInitiativeStatus(status)) return `invalid initiative status: ${status}`;
    const now = Date.now();
    const initiative = {
      id: `initiative-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      goal,
      summary: deps.readOption(args, "--summary"),
      status,
      priority: deps.normalizePriority(deps.readOption(args, "--priority")),
      sources: deps.parseCsvOption(args, "--source"),
      agentId: deps.readOption(args, "--agent") || deps.defaultAgentId,
      created_at: now,
      updated_at: now
    } as I;
    state.initiatives.push(initiative);
    return `Initiative ${initiative.id} created: "${initiative.title}" [${initiative.status}]`;
  }
  if (cmd === "update") {
    const initiative = deps.findInitiative(state, args[1]);
    if (!initiative) return `initiative not found: ${args[1] || ""}`;
    const status = deps.readOption(args, "--status");
    if (status && !deps.isInitiativeStatus(status)) return `invalid initiative status: ${status}`;
    initiative.title = deps.readOption(args, "--title") ?? initiative.title;
    initiative.goal = deps.readOption(args, "--goal") ?? initiative.goal;
    initiative.summary = deps.readOption(args, "--summary") ?? initiative.summary;
    initiative.status = status && deps.isInitiativeStatus(status) ? status : initiative.status;
    initiative.priority = deps.readOption(args, "--priority")
      ? deps.normalizePriority(deps.readOption(args, "--priority"))
      : initiative.priority;
    initiative.sources = deps.parseCsvOption(args, "--source") ?? initiative.sources;
    initiative.updated_at = Date.now();
    return `Initiative ${initiative.id} updated [${initiative.status}]`;
  }
  return "usage: king-ai initiative create|list|get|update|advance|persist";
}
