export type GuiCliDoc = {
  id: string;
  title: string;
  body: string;
  created_at: number;
};

export function runDocCommand<S extends { docs: GuiCliDoc[] }>(state: S, args: string[]): string {
  const cmd = args[0] || "list";
  if (cmd === "list") return JSON.stringify(state.docs, null, 2);
  if (cmd === "show") {
    const id = args[1];
    const doc = state.docs.find((row) => row.id === id);
    return doc ? `${doc.title}\n\n${doc.body}` : `doc not found: ${id}`;
  }
  if (cmd === "append") {
    const id = args[1];
    const doc = state.docs.find((row) => row.id === id);
    if (!doc) return `doc not found: ${id}`;
    const extra = args.slice(2).join(" ").trim();
    doc.body = doc.body ? `${doc.body}\n${extra}` : extra;
    return `doc appended ${doc.id}`;
  }
  if (cmd === "update") {
    const id = args[1];
    const doc = state.docs.find((row) => row.id === id);
    if (!doc) return `doc not found: ${id}`;
    doc.body = args.slice(2).join(" ").trim();
    return `doc updated ${doc.id}`;
  }
  if (cmd === "create") {
    const title = args[1] || "Untitled doc";
    const body = args.slice(2).join(" ").trim();
    const doc: GuiCliDoc = {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body,
      created_at: Date.now()
    };
    state.docs.push(doc);
    return `doc created ${doc.id}`;
  }
  return "usage: king-ai doc list|create|show|append|update";
}
