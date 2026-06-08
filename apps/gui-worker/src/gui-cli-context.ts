export type GuiCliContextEntry = {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
};

export type GuiCliContextActor = { id: string };

export type RunContextCommandDeps<A extends GuiCliContextActor> = {
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
};

export function runContextCommand<S extends { context: GuiCliContextEntry[] }, A extends GuiCliContextActor>(
  state: S,
  args: string[],
  actor: A,
  deps: RunContextCommandDeps<A>
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    if (state.context.length === 0) return "No context entries found.";
    return state.context
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((entry) => `${entry.key}\t${entry.value}\tupdatedBy=${entry.updatedBy}`)
      .join("\n");
  }
  if (cmd === "get") {
    const key = args[1];
    if (!key) return "usage: king-ai context get <key>";
    const entry = state.context.find((row) => row.key === key);
    return entry ? entry.value : `Key "${key}" not found.`;
  }
  if (cmd === "set") {
    const key = args[1];
    const value = deps.stripOptions(args.slice(2), ["--agent"]).join(" ").trim();
    if (!key || !value) return "usage: king-ai context set <key> <value>";
    const updatedBy = deps.readOption(args, "--agent") || actor.id;
    const existing = state.context.find((row) => row.key === key);
    if (existing) {
      existing.value = value;
      existing.updatedBy = updatedBy;
      existing.updatedAt = Date.now();
    } else {
      state.context.push({ key, value, updatedBy, updatedAt: Date.now() });
    }
    return `Set "${key}" = "${value}"`;
  }
  if (cmd === "delete" || cmd === "unset") {
    const key = args[1];
    if (!key) return "usage: king-ai context delete <key>";
    const before = state.context.length;
    state.context = state.context.filter((row) => row.key !== key);
    return state.context.length < before ? `Deleted "${key}"` : `Key "${key}" not found.`;
  }
  return "usage: king-ai context get|set|list|delete <key> [value]";
}
