export type GuiCliEvaluation = {
  id: string;
  selectedOptionId?: string;
  requiresHumanApproval?: boolean;
};

export type RunEvalCommandDeps<S extends { evaluations: GuiCliEvaluation[] }, E extends GuiCliEvaluation> = {
  findEvaluation: (state: S, id: string | undefined) => E | undefined;
  formatEvaluationLine: (evaluation: E) => string;
  formatEvaluationSummary: (evaluation: E) => string;
  firstJsonArg: (args: string[]) => string | undefined;
  parseEvaluationRecord: (raw: string, options: { artifactId?: string; initiativeId?: string }) => E;
  readOption: (args: string[], flag: string) => string | undefined;
};

export function runEvalCommand<S extends { evaluations: GuiCliEvaluation[] }, E extends GuiCliEvaluation>(
  state: S,
  args: string[],
  deps: RunEvalCommandDeps<S, E>
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const approvalOnly = args.includes("--approval-required");
    const rows = state.evaluations.filter((evaluation) => !approvalOnly || evaluation.requiresHumanApproval) as E[];
    if (rows.length === 0) return "No evaluations found.";
    return rows.map((evaluation) => deps.formatEvaluationLine(evaluation)).join("\n") + `\n\n${rows.length} evaluation(s)`;
  }
  if (cmd === "get") {
    const evaluation = deps.findEvaluation(state, args[1]);
    return evaluation ? JSON.stringify(evaluation, null, 2) : `evaluation not found: ${args[1] || ""}`;
  }
  if (cmd !== "parse" && cmd !== "record") {
    return "usage: king-ai eval parse|record|list|get '<json evaluation>' [--artifact id] [--initiative id]";
  }
  let evaluation: E;
  try {
    evaluation = deps.parseEvaluationRecord(deps.firstJsonArg(args.slice(1)) || "", {
      artifactId: deps.readOption(args, "--artifact"),
      initiativeId: deps.readOption(args, "--initiative")
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (cmd === "record") {
    state.evaluations.push(evaluation);
    return `evaluation recorded ${evaluation.id} selected=${evaluation.selectedOptionId} requiresApproval=${evaluation.requiresHumanApproval}`;
  }
  return deps.formatEvaluationSummary(evaluation);
}
