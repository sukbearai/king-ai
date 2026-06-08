import type { RoutedRuntimeMessage } from "@suwujs/king-ai/message-routing";

export interface ConversationTeamLike {
  id?: string;
  kind?: "direct" | "group";
  teamMode?: "single" | "team" | "custom";
  coordinatorAgentId?: string;
}

export interface WakeResolveContext {
  defaultConversationId: string;
  defaultCoordinatorAgentId: string;
  defaultWorkerAgentId: string;
  fallbackAgentId: string;
  cards: Array<{ id: string; assignee?: string; claimedBy?: string }>;
  tasks: Array<{ id: string; assignee?: string }>;
  conversations: ConversationTeamLike[];
}

function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id || undefined;
}

function coordinatorAgentIdFor(conversation: ConversationTeamLike, ctx: WakeResolveContext): string {
  return normalizeAgentId(conversation.coordinatorAgentId) ?? ctx.defaultCoordinatorAgentId;
}

export function shouldAutoDelegateMessage(conversation: ConversationTeamLike, messageBody = ""): boolean {
  const mode = conversation.teamMode ?? "team";
  if (mode === "single") return true;
  const body = messageBody.trim();
  if (!body) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no)[!.?\s]*$/i.test(body)) return false;
  if (/^(你好|大家好|谢谢|在吗|收到)[!.?\s]*$/u.test(body)) return false;
  return true;
}

export function triageResponseMode(
  conversation: ConversationTeamLike | undefined,
  top: RoutedRuntimeMessage | undefined,
  agentId: string
): "me" | "each" | "one-of-us" {
  if (top?.row.to_agent_id === agentId) return "me";
  if (conversation?.kind === "direct") return "me";
  const mode = conversation?.teamMode ?? "team";
  if (mode === "single") return "me";
  return "one-of-us";
}

export function resolveWakeData(ctx: WakeResolveContext, data: Record<string, unknown>): Record<string, unknown> {
  const at = typeof data.at === "number" ? data.at : Date.now();
  const base: Record<string, unknown> = { ...data, at };
  if (normalizeAgentId(base.agentId)) return base;
  if (base.resetState === true || base.importedState === true) return base;

  if (typeof base.cardId === "string") {
    const card = ctx.cards.find((row) => row.id === base.cardId || row.id.startsWith(base.cardId as string));
    const agentId = normalizeAgentId(card?.assignee) ?? normalizeAgentId(card?.claimedBy);
    if (agentId) return { ...base, agentId };
  }
  if (typeof base.taskId === "string") {
    const task = ctx.tasks.find((row) => row.id === base.taskId || row.id.startsWith(base.taskId as string));
    const agentId = normalizeAgentId(task?.assignee);
    if (agentId) return { ...base, agentId };
  }
  if (typeof base.clearedConversationId === "string") {
    const conversation = ctx.conversations.find((row) => row.id === base.clearedConversationId);
    if (conversation) return { ...base, agentId: coordinatorAgentIdFor(conversation, ctx) };
  }
  if (typeof base.conversationId === "string") {
    const conversation = ctx.conversations.find((row) => row.id === base.conversationId);
    if (conversation) return { ...base, agentId: coordinatorAgentIdFor(conversation, ctx) };
  }
  if (base.agenda === true) return { ...base, agentId: ctx.defaultWorkerAgentId };

  const fallbackConversation =
    ctx.conversations.find((row) => row.id === ctx.defaultConversationId) ?? ctx.conversations[0];
  if (fallbackConversation) return { ...base, agentId: coordinatorAgentIdFor(fallbackConversation, ctx) };
  return { ...base, agentId: ctx.fallbackAgentId };
}

export function resolveWakeEvent(ctx: WakeResolveContext, evt: { event: string; data: unknown }): { event: string; data: unknown } {
  if (evt.event !== "wake" || !evt.data || typeof evt.data !== "object") return evt;
  return { ...evt, data: resolveWakeData(ctx, evt.data as Record<string, unknown>) };
}

export function wakeEventVisibleToAgent(evt: { data: unknown }, agentId: string): boolean {
  if (!evt.data || typeof evt.data !== "object") return false;
  const data = evt.data as Record<string, unknown>;
  const target = normalizeAgentId(data.agentId);
  if (target) return target === agentId;
  if (data.resetState === true || data.importedState === true) return true;
  return false;
}
