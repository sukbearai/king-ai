export type GuiCliRunFeedback = {
  id: string;
  agentId: string;
  taskCompleted?: boolean;
  errored?: boolean;
};

export type RunFeedbackCommandDeps<S extends { runFeedback: GuiCliRunFeedback[] }, F extends GuiCliRunFeedback> = {
  findRunFeedback: (state: S, id: string | undefined) => F | undefined;
  formatRunFeedbackLine: (feedback: F) => string;
  formatRunFeedbackSummaryLine: (summary: unknown) => string;
  summarizeRunFeedback: (rows: F[]) => unknown[];
  parseRunFeedback: (args: string[]) => F;
  readOption: (args: string[], flag: string) => string | undefined;
  readBooleanOption: (args: string[], flag: string) => boolean | undefined;
};

export function runFeedbackCommand<S extends { runFeedback: GuiCliRunFeedback[] }, F extends GuiCliRunFeedback>(
  state: S,
  args: string[],
  deps: RunFeedbackCommandDeps<S, F>,
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const agent = deps.readOption(args, "--agent");
    const errored = deps.readBooleanOption(args, "--errored");
    const completed = deps.readBooleanOption(args, "--completed");
    const rows = state.runFeedback.filter(
      (feedback) =>
        (!agent || feedback.agentId === agent) &&
        (errored === undefined || feedback.errored === errored) &&
        (completed === undefined || feedback.taskCompleted === completed),
    ) as F[];
    if (rows.length === 0) return "No run feedback found.";
    return (
      rows.map((feedback) => deps.formatRunFeedbackLine(feedback)).join("\n") + `\n\n${rows.length} feedback record(s)`
    );
  }
  if (cmd === "get") {
    const feedback = deps.findRunFeedback(state, args[1]);
    return feedback ? JSON.stringify(feedback, null, 2) : `feedback not found: ${args[1] || ""}`;
  }
  if (cmd === "summary") {
    const agent = deps.readOption(args, "--agent");
    const rows = state.runFeedback.filter((feedback) => !agent || feedback.agentId === agent) as F[];
    if (rows.length === 0) return "No run feedback found.";
    return deps
      .summarizeRunFeedback(rows)
      .map((summary) => deps.formatRunFeedbackSummaryLine(summary))
      .join("\n");
  }
  if (cmd === "record") {
    let feedback: F;
    try {
      feedback = deps.parseRunFeedback(args);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    state.runFeedback.push(feedback);
    return `feedback recorded ${feedback.id} agent=${feedback.agentId} completed=${feedback.taskCompleted} errored=${feedback.errored}`;
  }
  return "usage: king-ai feedback record|list|summary|get [--agent agent-id] [--completed true|false]";
}
