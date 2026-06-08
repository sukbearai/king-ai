export type GuiCliReaction = {
  messageId: string;
  emoji: string;
  authorId: string;
  created_at: number;
};

export type GuiCliReactActor = { id: string };

export function runReactCommand<S extends { reactions: GuiCliReaction[] }, A extends GuiCliReactActor>(
  state: S,
  args: string[],
  actor: A
): string {
  const messageId = args[0];
  const emoji = args[1] || "(ok)";
  if (!messageId) return "usage: king-ai react <messageId> <emoji>";
  state.reactions.push({ messageId, emoji, authorId: actor.id, created_at: Date.now() });
  return `reaction posted ${messageId} ${emoji}`;
}
