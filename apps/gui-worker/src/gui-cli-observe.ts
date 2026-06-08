export type GuiCliLoopSnapshot = {
  classification: string;
  reasons: string[];
  counts: {
    unreadMessages: number;
    blockedTasks: number;
    activeTasks: number;
    openCapsules: number;
    inReviewCapsules: number;
    artifacts: number;
    failedRuns: number;
  };
};

export type RunObserveCommandDeps<S> = {
  buildLoopSnapshot: (state: S) => GuiCliLoopSnapshot;
  readOption: (args: string[], flag: string) => string | undefined;
};

export function runObserveCommand<S>(state: S, args: string[], deps: RunObserveCommandDeps<S>): string {
  const snapshot = deps.buildLoopSnapshot(state);
  const filter = deps.readOption(args, "--classification");
  if (filter && snapshot.classification !== filter) {
    return `No observe snapshot matching classification=${filter}. Current classification=${snapshot.classification}.`;
  }
  if (args.includes("--json")) return JSON.stringify(snapshot, null, 2);
  return [
    `classification=${snapshot.classification}`,
    `reasons=${snapshot.reasons.join("; ")}`,
    `unread=${snapshot.counts.unreadMessages}`,
    `blocked=${snapshot.counts.blockedTasks}`,
    `activeTasks=${snapshot.counts.activeTasks}`,
    `openCapsules=${snapshot.counts.openCapsules}`,
    `inReviewCapsules=${snapshot.counts.inReviewCapsules}`,
    `artifacts=${snapshot.counts.artifacts}`,
    `failedRuns=${snapshot.counts.failedRuns}`
  ].join("\n");
}
