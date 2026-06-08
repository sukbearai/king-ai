export type GuiCliCapsuleStatus = "open" | "in_review" | "merged" | "abandoned";
export type GuiCliCapsuleScopeType = "code" | "docs" | "tests" | "ops" | "mixed";

export type GuiCliCapsule = {
  id: string;
  goal: string;
  ownerAgent: string;
  branch: string;
  baseCommit: string;
  allowedPaths: string[];
  acceptance: string;
  reviewer?: string;
  status: GuiCliCapsuleStatus | string;
  initiativeId?: string;
  taskId?: string;
  subsystem?: string;
  scopeType?: GuiCliCapsuleScopeType;
  blockedBy?: string[];
  supersedes?: string;
  created_at: number;
  updated_at: number;
};

export type RunCapsuleCommandDeps<
  S extends { capsules: GuiCliCapsule[] },
  C extends GuiCliCapsule
> = {
  defaultAgentId: string;
  findCapsule: (state: S, id: string | undefined) => C | undefined;
  formatCapsuleLine: (capsule: C) => string;
  capsuleConflicts: (state: S, capsule: C) => Array<{ id: string; level: "weak_conflict" | "high_conflict" }>;
  parseAllowedPaths: (args: string[]) => string[];
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
  parseCsvOption: (args: string[], flag: string) => string[] | undefined;
  isCapsuleStatus: (value: string) => value is GuiCliCapsuleStatus;
  isCapsuleScopeType: (value: string) => value is GuiCliCapsuleScopeType;
};

export function runCapsuleCommand<
  S extends { capsules: GuiCliCapsule[] },
  C extends GuiCliCapsule
>(state: S, args: string[], deps: RunCapsuleCommandDeps<S, C>): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const status = deps.readOption(args, "--status");
    const owner = deps.readOption(args, "--owner");
    const reviewer = deps.readOption(args, "--reviewer");
    const initiative = deps.readOption(args, "--initiative");
    const capsules = state.capsules.filter((capsule) =>
      (!status || capsule.status === status) &&
      (!owner || capsule.ownerAgent === owner) &&
      (!reviewer || capsule.reviewer === reviewer) &&
      (!initiative || capsule.initiativeId === initiative)
    ) as C[];
    if (capsules.length === 0) return "No capsules found.";
    return capsules.map((capsule) => deps.formatCapsuleLine(capsule)).join("\n") + `\n\n${capsules.length} capsule(s)`;
  }
  if (cmd === "mine") {
    const agent = deps.readOption(args, "--agent") || deps.defaultAgentId;
    const status = deps.readOption(args, "--status");
    const capsules = state.capsules.filter((capsule) =>
      capsule.ownerAgent === agent &&
      (!status || capsule.status === status)
    ) as C[];
    if (capsules.length === 0) return "No owned capsules found.";
    return capsules.map((capsule) => `${deps.formatCapsuleLine(capsule)}\n  acceptance: ${capsule.acceptance}`).join("\n");
  }
  if (cmd === "get") {
    const capsule = deps.findCapsule(state, args[1]);
    return capsule ? JSON.stringify(capsule, null, 2) : `capsule not found: ${args[1] || ""}`;
  }
  if (cmd === "create") {
    const goal = deps.readOption(args, "--goal") || deps.stripOptions(args.slice(1), [
      "--owner", "--branch", "--base", "--paths", "--path", "--acceptance", "--reviewer",
      "--initiative", "--task", "--subsystem", "--scope-type", "--blocked-by", "--supersedes"
    ]).join(" ").trim();
    const ownerAgent = deps.readOption(args, "--owner") || deps.defaultAgentId;
    const branch = deps.readOption(args, "--branch") || `king-ai/${ownerAgent}/${Date.now()}`;
    const baseCommit = deps.readOption(args, "--base") || "unknown";
    const allowedPaths = deps.parseAllowedPaths(args);
    const acceptance = deps.readOption(args, "--acceptance") || "Owner documents the change and required verification.";
    const scopeType = deps.readOption(args, "--scope-type");
    if (!goal || allowedPaths.length === 0) {
      return "usage: king-ai capsule create --goal <goal> --paths a,b [--owner agent-id] [--branch name] [--base sha] [--acceptance text]";
    }
    if (scopeType && !deps.isCapsuleScopeType(scopeType)) return `invalid capsule scope type: ${scopeType}`;
    const now = Date.now();
    const capsule = {
      id: `capsule-${now}-${Math.random().toString(36).slice(2)}`,
      goal,
      ownerAgent,
      branch,
      baseCommit,
      allowedPaths,
      acceptance,
      reviewer: deps.readOption(args, "--reviewer"),
      status: "open",
      initiativeId: deps.readOption(args, "--initiative"),
      taskId: deps.readOption(args, "--task"),
      subsystem: deps.readOption(args, "--subsystem"),
      scopeType: scopeType && deps.isCapsuleScopeType(scopeType) ? scopeType : undefined,
      blockedBy: deps.parseCsvOption(args, "--blocked-by"),
      supersedes: deps.readOption(args, "--supersedes"),
      created_at: now,
      updated_at: now
    } as C;
    const conflicts = deps.capsuleConflicts(state, capsule);
    state.capsules.push(capsule);
    return `Capsule ${capsule.id} created on ${capsule.branch} [${capsule.status}]` +
      (conflicts.length ? `\nConflicts: ${conflicts.map((conflict) => `${conflict.id.slice(0, 14)}(${conflict.level})`).join(", ")}` : "");
  }
  if (cmd === "update") {
    const capsule = deps.findCapsule(state, args[1]);
    if (!capsule) return `capsule not found: ${args[1] || ""}`;
    const status = deps.readOption(args, "--status");
    const scopeType = deps.readOption(args, "--scope-type");
    if (status && !deps.isCapsuleStatus(status)) return `invalid capsule status: ${status}`;
    if (scopeType && !deps.isCapsuleScopeType(scopeType)) return `invalid capsule scope type: ${scopeType}`;
    capsule.goal = deps.readOption(args, "--goal") ?? capsule.goal;
    capsule.ownerAgent = deps.readOption(args, "--owner") ?? capsule.ownerAgent;
    capsule.branch = deps.readOption(args, "--branch") ?? capsule.branch;
    capsule.baseCommit = deps.readOption(args, "--base") ?? capsule.baseCommit;
    capsule.acceptance = deps.readOption(args, "--acceptance") ?? capsule.acceptance;
    capsule.reviewer = deps.readOption(args, "--reviewer") ?? capsule.reviewer;
    capsule.status = status && deps.isCapsuleStatus(status) ? status : capsule.status;
    capsule.initiativeId = deps.readOption(args, "--initiative") ?? capsule.initiativeId;
    capsule.taskId = deps.readOption(args, "--task") ?? capsule.taskId;
    capsule.subsystem = deps.readOption(args, "--subsystem") ?? capsule.subsystem;
    capsule.scopeType = scopeType && deps.isCapsuleScopeType(scopeType) ? scopeType : capsule.scopeType;
    capsule.blockedBy = deps.parseCsvOption(args, "--blocked-by") ?? capsule.blockedBy;
    capsule.supersedes = deps.readOption(args, "--supersedes") ?? capsule.supersedes;
    const allowedPaths = deps.parseAllowedPaths(args);
    if (allowedPaths.length) capsule.allowedPaths = allowedPaths;
    capsule.updated_at = Date.now();
    return `Capsule ${capsule.id} updated [${capsule.status}]`;
  }
  return "usage: king-ai capsule create|list|mine|get|update";
}
