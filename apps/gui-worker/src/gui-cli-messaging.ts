export type GuiCliMessageActor = {
  id: string;
  name: string;
  engine?: string;
};

export type GuiCliOutboundMessage = {
  id: string;
  conversation_id: string;
  author_name: string;
  author_kind: string;
  author_engine?: string;
  body: string;
  priority?: string;
  message_type?: string;
  to_agent_id?: string;
  created_at: number;
  readBy: string[];
};

export type GuiCliRoutedMessageRow = {
  row: GuiCliInboundMessage;
};

export type GuiCliInboundMessage = GuiCliOutboundMessage & {
  author_kind: string;
};

export type NewAgentMessageInput = {
  target: string;
  fromId?: string;
  fromName: string;
  fromKind: string;
  fromEngine?: string;
  body: string;
  priority: "normal" | "steer";
  messageType: "message" | "decision" | "blocker";
};

export type RunMessagingDeps<S extends { messages: GuiCliInboundMessage[]; agents: Array<{ id: string; name: string }> }> = {
  defaultAgentId: string;
  newAgentMessage: (input: NewAgentMessageInput) => GuiCliOutboundMessage;
  resolveEscalationTarget: (state: S) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
  isRuntimeVisibleMessage: (message: GuiCliInboundMessage) => boolean;
  sortRuntimeMessages: (messages: GuiCliInboundMessage[], agentId: string) => GuiCliRoutedMessageRow[];
  messageRouteTag: (routed: GuiCliRoutedMessageRow) => string;
};

export function runDmCommand<S extends { messages: GuiCliInboundMessage[]; agents: Array<{ id: string; name: string }> }>(
  state: S,
  args: string[],
  actor: GuiCliMessageActor,
  deps: RunMessagingDeps<S>
): string {
  const target = args[0] || deps.defaultAgentId;
  const body = args.slice(1).join(" ").trim() || "(empty dm)";
  const message = deps.newAgentMessage({
    target,
    fromId: actor.id,
    fromName: actor.name,
    fromKind: "agent",
    fromEngine: actor.engine,
    body,
    priority: "normal",
    messageType: "message"
  });
  message.readBy.push(actor.id);
  state.messages.push(message);
  return `dm posted ${message.conversation_id}`;
}

export function runSendCommand<S extends { messages: GuiCliInboundMessage[]; agents: Array<{ id: string; name: string }> }>(
  state: S,
  args: string[],
  actor: GuiCliMessageActor,
  deps: RunMessagingDeps<S>
): string {
  const target = args[0];
  const messageType = deps.readOption(args, "--type") || "message";
  if (messageType !== "message" && messageType !== "decision" && messageType !== "blocker") {
    return "usage: king-ai send <agentId> <message> [--steer] [--type message|decision|blocker]";
  }
  const body = deps.stripOptions(args.slice(1), ["--type"]).filter((arg) => arg !== "--steer").join(" ").trim();
  if (!target || !body) return "usage: king-ai send <agentId> <message> [--steer] [--type message|decision|blocker]";
  const message = deps.newAgentMessage({
    target,
    fromId: actor.id,
    fromName: actor.name,
    fromKind: "agent",
    fromEngine: actor.engine,
    body,
    priority: args.includes("--steer") ? "steer" : "normal",
    messageType: messageType as "message" | "decision" | "blocker"
  });
  message.readBy.push(actor.id);
  state.messages.push(message);
  return `Message ${message.id} queued -> ${target} (${messageType}, ${message.priority})`;
}

export function runRecvCommand<S extends { messages: GuiCliInboundMessage[]; agents: Array<{ id: string; name: string }> }>(
  state: S,
  args: string[],
  deps: RunMessagingDeps<S>
): string {
  const agentId = deps.readOption(args, "--agent") || deps.defaultAgentId;
  const routedRows = deps.sortRuntimeMessages(
    state.messages.filter((message) =>
      deps.isRuntimeVisibleMessage(message) &&
      (!message.to_agent_id || message.to_agent_id === agentId) &&
      !message.readBy.includes(agentId)
    ),
    agentId
  ).slice(0, 10);
  if (routedRows.length === 0) return "No pending messages.";
  for (const routed of routedRows) routed.row.readBy.push(agentId);
  return routedRows.map((routed) => {
    const row = routed.row;
    return `[${deps.messageRouteTag(routed)}] ${row.author_name} (${new Date(row.created_at).toISOString()}): ${row.body}`;
  }).join("\n");
}

export function runEscalateCommand<S extends { messages: GuiCliInboundMessage[]; agents: Array<{ id: string; name: string }> }>(
  state: S,
  args: string[],
  actor: GuiCliMessageActor,
  deps: RunMessagingDeps<S>
): string {
  const body = args.join(" ").trim();
  if (!body) return "usage: king-ai escalate <message>";
  const target = deps.resolveEscalationTarget(state);
  const message = deps.newAgentMessage({
    target,
    fromId: actor.id,
    fromName: actor.name,
    fromKind: "agent",
    fromEngine: actor.engine,
    body,
    priority: "steer",
    messageType: "decision"
  });
  state.messages.push(message);
  return `Escalated to ${target}: ${message.id} (queued)`;
}
