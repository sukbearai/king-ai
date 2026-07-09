export type GuiCliAgent = {
  id: string;
  name: string;
  role: string;
};

export type GuiCliAgentStateSummary = {
  id: string;
  name: string;
  role: string;
  engine: string;
  lifecycle: string;
  status: string;
  model: string;
  fastModel: string;
  unreadMessages: number;
  openClaims: number;
  activeCards: number;
  openTasks: number;
  blockedTasks: number;
  lastStatusAt?: number;
};

export type RunAgentsCommandDeps<S extends { agents: GuiCliAgent[] }, A extends GuiCliAgentStateSummary> = {
  agentStateSummary: (state: S, agent: GuiCliAgent) => A;
  formatAgentMatrixLine: (agent: A) => string;
};

export function runAgentsCommand<S extends { agents: GuiCliAgent[] }, A extends GuiCliAgentStateSummary>(
  state: S,
  args: string[],
  deps: RunAgentsCommandDeps<S, A>,
): string {
  const cmd = args[0];
  if (cmd === "spawn") return "agent spawn is not supported by this gui runtime";
  if (cmd === "destroy") return "agent destroy is not supported by this gui runtime";
  const agents = state.agents.map((agent) => deps.agentStateSummary(state, agent));
  if (agents.length === 0) return "No agents configured.";
  return ["Agent Matrix:", "-".repeat(56), ...agents.map((agent) => deps.formatAgentMatrixLine(agent))].join("\n");
}
