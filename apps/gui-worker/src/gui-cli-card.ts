import {
  applyGuiKanbanClaim,
  applyGuiKanbanMove,
  applyGuiKanbanRelease,
  type GuiKanbanCardLike,
  type GuiKanbanColumn,
} from "./workflow-state.js";

export type GuiCliCard = GuiKanbanCardLike & {
  allowedPaths?: string[];
  created_at?: number;
};

export type RunCardCommandDeps<S extends { cards: GuiCliCard[] }> = {
  defaultAgentId: string;
  createCard: (state: S, title: string, allowedPaths: string[]) => GuiCliCard;
  pathConflict: (state: S, paths: string[], owner: string, excludeCardId?: string) => string | null | undefined;
  parseAllowedPaths: (args: string[]) => string[];
  stripOptions: (args: string[], flags: string[]) => string[];
  readOption: (args: string[], flag: string) => string | undefined;
};

export function runCardCommand<S extends { cards: GuiCliCard[] }>(
  state: S,
  args: string[],
  deps: RunCardCommandDeps<S>,
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") return JSON.stringify(state.cards, null, 2);
  if (cmd === "create") {
    const allowedPaths = deps.parseAllowedPaths(args);
    const title = deps.stripOptions(args.slice(1), ["--paths", "--path"]).join(" ").trim() || "Untitled card";
    const card = deps.createCard(state, title, allowedPaths);
    return `card created ${card.id}${allowedPaths.length ? ` paths=${allowedPaths.join(",")}` : ""}`;
  }
  if (cmd === "claim") {
    const id = args[1];
    const owner = deps.readOption(args, "--owner") || deps.defaultAgentId;
    const card = state.cards.find((row) => row.id === id);
    if (!card) return `card not found: ${id}`;
    if (card.claimedBy && card.claimedBy !== owner) return `card already claimed by ${card.claimedBy}`;
    const conflict = deps.pathConflict(state, card.allowedPaths ?? [], owner, card.id);
    if (conflict) return `path conflict: ${conflict}`;
    applyGuiKanbanClaim(card, owner);
    return `card claimed ${card.id}${card.allowedPaths?.length ? ` paths=${card.allowedPaths.join(",")}` : ""}`;
  }
  if (cmd === "release" || cmd === "unclaim") {
    const id = args[1];
    const card = state.cards.find((row) => row.id === id);
    if (!card) return `card not found: ${id}`;
    applyGuiKanbanRelease(card);
    return `card released ${card.id}`;
  }
  if (cmd === "done") {
    const id = args[1];
    const card = state.cards.find((row) => row.id === id);
    if (!card) return `card not found: ${id}`;
    applyGuiKanbanMove(card, "done");
    return `card moved ${card.id} done`;
  }
  if (cmd === "move") {
    const id = args[1];
    const column = args[2] as GuiKanbanColumn | undefined;
    const card = state.cards.find((row) => row.id === id);
    if (!card) return `card not found: ${id}`;
    if (column !== "todo" && column !== "doing" && column !== "done")
      return "usage: king-ai card move <id> todo|doing|done";
    applyGuiKanbanMove(card, column);
    return `card moved ${card.id} ${column}`;
  }
  return "usage: king-ai card list|create|claim|move|done|release";
}
