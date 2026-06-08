export type GuiCliHypothesisStatus = "proposed" | "active" | "validated" | "rejected" | "abandoned";

export type GuiCliHypothesis = {
  id: string;
  title: string;
  status: GuiCliHypothesisStatus;
  agentId: string;
  parentId?: string;
  rationale?: string;
  expectedValue?: string;
  estimatedCost?: string;
  outcome?: string;
  evidenceArtifactIds?: string[];
  created_at: number;
  updated_at: number;
};

export type GuiCliHypothesisActor = { id: string };

export type RunHypothesisCommandDeps<S extends { hypotheses: GuiCliHypothesis[] }, H extends GuiCliHypothesis> = {
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
  parseCsvOption: (args: string[], flag: string) => string[] | undefined;
  isHypothesisStatus: (value: string) => value is GuiCliHypothesisStatus;
  findHypothesis: (state: S, id: string | undefined) => H | undefined;
  formatHypothesisLine: (hypothesis: H) => string;
};

export function runHypothesisCommand<
  S extends { hypotheses: GuiCliHypothesis[] },
  H extends GuiCliHypothesis,
  A extends GuiCliHypothesisActor
>(state: S, args: string[], actor: A, deps: RunHypothesisCommandDeps<S, H>): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const status = deps.readOption(args, "--status");
    const treeRoot = deps.readOption(args, "--tree");
    const rows = state.hypotheses.filter((hypothesis) =>
      (!status || hypothesis.status === status) &&
      (!treeRoot || hypothesis.id === treeRoot || hypothesis.parentId === treeRoot)
    ) as H[];
    if (rows.length === 0) return "No hypotheses found.";
    return rows.map((hypothesis) => deps.formatHypothesisLine(hypothesis)).join("\n") + `\n\n${rows.length} hypothesis(es)`;
  }
  if (cmd === "create") {
    const title = deps.stripOptions(args.slice(1), ["--rationale", "--expected-value", "--estimated-cost", "--parent", "--agent"]).join(" ").trim();
    if (!title) return "usage: king-ai hypothesis create <title> [--rationale text] [--expected-value text] [--estimated-cost text] [--parent id]";
    const now = Date.now();
    const hypothesis = {
      id: `hyp-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      status: "proposed",
      agentId: deps.readOption(args, "--agent") || actor.id,
      parentId: deps.readOption(args, "--parent"),
      rationale: deps.readOption(args, "--rationale"),
      expectedValue: deps.readOption(args, "--expected-value"),
      estimatedCost: deps.readOption(args, "--estimated-cost"),
      created_at: now,
      updated_at: now
    } as H;
    state.hypotheses.push(hypothesis);
    return `Hypothesis ${hypothesis.id} created: ${hypothesis.title}`;
  }
  if (cmd === "update") {
    const hypothesis = deps.findHypothesis(state, args[1]);
    if (!hypothesis) return `hypothesis not found: ${args[1] || ""}`;
    const status = deps.readOption(args, "--status");
    if (status && !deps.isHypothesisStatus(status)) return `invalid hypothesis status: ${status}`;
    const nextStatus: GuiCliHypothesisStatus = status && deps.isHypothesisStatus(status) ? status : hypothesis.status;
    hypothesis.status = nextStatus;
    hypothesis.outcome = deps.readOption(args, "--outcome") ?? hypothesis.outcome;
    hypothesis.evidenceArtifactIds = deps.parseCsvOption(args, "--evidence") ?? hypothesis.evidenceArtifactIds;
    hypothesis.updated_at = Date.now();
    return `Hypothesis ${hypothesis.id} updated: status=${hypothesis.status}`;
  }
  return "usage: king-ai hypothesis create|list|update";
}
