export type GuiCliLoopEvent = {
  type: string;
  agent?: string;
  loop: number;
  runId?: string;
  timestamp?: string | number;
};

export type GuiCliLoopState = {
  loopRunId?: string;
  currentLoop: number;
  loopEvents: GuiCliLoopEvent[];
};

export type RunLoopCommandDeps<S extends GuiCliLoopState> = {
  readOption: (args: string[], flag: string) => string | undefined;
  parseCsvOption: (args: string[], flag: string) => string[] | undefined;
  readNumberOption: (args: string[], flag: string) => number | undefined;
  parseEventPayload: (args: string[]) => unknown;
  normalizePositiveInt: (value: string | undefined, fallback: number) => number;
  isLoopEventType: (value: string | undefined) => boolean;
  pushLoopEvent: (state: S, event: Record<string, unknown>) => GuiCliLoopEvent;
  buildEventLoopSnapshot: (state: S) => {
    runId?: string;
    loop?: number;
    classification: string;
    reasons: string[];
    recentEvents?: unknown[];
  };
  formatLoopEventLine: (event: GuiCliLoopEvent) => string;
};

export function runLoopCommand<S extends GuiCliLoopState>(
  state: S,
  args: string[],
  deps: RunLoopCommandDeps<S>,
): string {
  const cmd = args[0] || "recent";
  if (cmd === "tick") {
    const runId = deps.readOption(args, "--run") || state.loopRunId || "run-gui";
    state.loopRunId = runId;
    state.currentLoop += 1;
    deps.pushLoopEvent(state, { type: "loop.tick", runId, loop: state.currentLoop });
    return `loop tick ${state.currentLoop} run=${runId}`;
  }
  if (cmd === "emit") {
    const type = args[1];
    if (!deps.isLoopEventType(type)) {
      return "usage: king-ai loop emit <eventType> [--agent id] [--task id] [--pending n] '<payload json>'";
    }
    const event = deps.pushLoopEvent(state, {
      type,
      agent: deps.readOption(args, "--agent"),
      taskId: deps.readOption(args, "--task"),
      from: deps.readOption(args, "--from"),
      to: deps.readOption(args, "--to"),
      waitingOn: deps.parseCsvOption(args, "--waiting-on"),
      pendingMessages: deps.readNumberOption(args, "--pending"),
      kind: deps.readOption(args, "--kind"),
      path: deps.readOption(args, "--path"),
      tokens: deps.readNumberOption(args, "--tokens"),
      budget: deps.readNumberOption(args, "--budget"),
      payload: deps.parseEventPayload(args.slice(2)),
    });
    return `loop event ${event.type} recorded loop=${event.loop}`;
  }
  if (cmd === "classify") {
    const snapshot = deps.buildEventLoopSnapshot(state);
    deps.pushLoopEvent(state, {
      type: "loop.classified",
      classification: snapshot.classification,
      reasons: snapshot.reasons,
    });
    return `loop classified ${snapshot.classification}: ${snapshot.reasons.join("; ")}`;
  }
  if (cmd === "snapshot") {
    const snapshot = deps.buildEventLoopSnapshot(state);
    return args.includes("--json")
      ? JSON.stringify(snapshot, null, 2)
      : [
          `run=${snapshot.runId}`,
          `loop=${snapshot.loop}`,
          `classification=${snapshot.classification}`,
          `reasons=${snapshot.reasons.join("; ")}`,
          `events=${snapshot.recentEvents?.length ?? 0}`,
        ].join("\n");
  }
  if (cmd === "recent" || cmd === "list") {
    const type = deps.readOption(args, "--type");
    const agent = deps.readOption(args, "--agent");
    const limit = deps.normalizePositiveInt(deps.readOption(args, "--limit"), 20);
    const rows = state.loopEvents
      .filter((event) => (!type || event.type === type) && (!agent || event.agent === agent))
      .slice(-limit);
    if (args.includes("--json")) return JSON.stringify(rows, null, 2);
    if (rows.length === 0) return "No loop events found.";
    return rows.map((event) => deps.formatLoopEventLine(event)).join("\n") + `\n\n${rows.length} loop event(s)`;
  }
  return "usage: king-ai loop tick|emit|classify|recent|snapshot";
}
