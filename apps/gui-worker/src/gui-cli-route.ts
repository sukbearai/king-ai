export type GuiCliEventRoute = {
  eventType: string;
  agentId: string;
  createdAt: number;
};

export type GuiCliRouteAgent = {
  id: string;
  name: string;
  role?: string;
  events?: string[];
};

export type GuiCliExternalEvent = {
  type: string;
  source?: string;
  payload?: unknown;
  timestamp?: number;
};

export type RunRouteCommandDeps<
  S extends {
    eventRoutes: GuiCliEventRoute[];
    agents: GuiCliRouteAgent[];
  },
> = {
  defaultAgentId: string;
  ensureRouteAgent: (state: S, agentId: string) => string | undefined;
  formatEventRouteLine: (route: GuiCliEventRoute) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  parseExternalEventArgs: (eventType: string, args: string[]) => GuiCliExternalEvent;
  routeExternalEvent: (state: S, event: GuiCliExternalEvent) => string[];
  pushLoopEvent: (state: S, event: Record<string, unknown>) => void;
  countPendingMessages: (state: S, agentId: string) => number;
};

export function runRouteCommand<
  S extends {
    eventRoutes: GuiCliEventRoute[];
    agents: GuiCliRouteAgent[];
  },
>(state: S, args: string[], deps: RunRouteCommandDeps<S>): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const eventType = (args[1] && !args[1].startsWith("--") ? args[1] : undefined) || deps.readOption(args, "--type");
    const rows = state.eventRoutes.filter((route) => !eventType || route.eventType === eventType);
    if (rows.length === 0) return "No event routes found.";
    return rows.map((route) => deps.formatEventRouteLine(route)).join("\n") + `\n\n${rows.length} route(s)`;
  }
  if (cmd === "set") {
    const eventType = args[1];
    const agentId = deps.readOption(args, "--agent") || args[2] || deps.defaultAgentId;
    if (!eventType) return "usage: king-ai route set <eventType> --agent <agentId>";
    const agentError = deps.ensureRouteAgent(state, agentId);
    if (agentError) return agentError;
    if (!state.eventRoutes.some((route) => route.eventType === eventType && route.agentId === agentId)) {
      state.eventRoutes.push({ eventType, agentId, createdAt: Date.now() });
    }
    for (const agent of state.agents.filter((row) => row.id === agentId)) {
      agent.events = [...new Set([...(agent.events ?? []), eventType])];
    }
    return `route set ${eventType} -> ${agentId}`;
  }
  if (cmd === "delete" || cmd === "remove") {
    const eventType = args[1];
    const agentId = deps.readOption(args, "--agent") || args[2];
    if (!eventType) return "usage: king-ai route delete <eventType> [--agent <agentId>]";
    const before = state.eventRoutes.length;
    state.eventRoutes = state.eventRoutes.filter(
      (route) => route.eventType !== eventType || (agentId && route.agentId !== agentId),
    );
    for (const agent of state.agents) {
      if (!agentId || agent.id === agentId) agent.events = (agent.events ?? []).filter((event) => event !== eventType);
    }
    return state.eventRoutes.length < before
      ? `route deleted ${eventType}${agentId ? ` -> ${agentId}` : ""}`
      : `route not found: ${eventType}`;
  }
  if (cmd === "emit") {
    const eventType = args[1];
    if (!eventType) return "usage: king-ai route emit <eventType> [--source source] '<payload json>'";
    const event = deps.parseExternalEventArgs(eventType, args.slice(2));
    const routed = deps.routeExternalEvent(state, event);
    for (const agentId of routed) {
      deps.pushLoopEvent(state, {
        type: "queue.backlog",
        agent: agentId,
        pendingMessages: deps.countPendingMessages(state, agentId),
        payload: event,
      });
    }
    return routed.length
      ? `event routed ${event.type} -> ${routed.join(",")}`
      : `event ignored ${event.type}: no subscribers`;
  }
  return "usage: king-ai route set|list|delete|emit <eventType> [--agent agent-id] [--source source] '<payload json>'";
}
