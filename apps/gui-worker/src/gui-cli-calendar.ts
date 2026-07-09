export type GuiCliCalendarItem = {
  id: string;
  title: string;
  at: string;
  cron?: string;
  assignee?: string;
  prompt?: string;
  created_at: number;
};

export type RunCalendarCommandDeps = {
  defaultAgentId: string;
  readOption: (args: string[], flag: string) => string | undefined;
  parseCron: (cron: string) => unknown;
};

export function runCalendarCommand<S extends { calendar: GuiCliCalendarItem[] }>(
  state: S,
  args: string[],
  deps: RunCalendarCommandDeps,
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") return JSON.stringify(state.calendar, null, 2);
  if (cmd === "create") {
    const atIdx = args.indexOf("--at");
    const assigneeIdx = args.indexOf("--assignee");
    const promptIdx = args.indexOf("--prompt");
    const cron = deps.readOption(args, "--cron");
    // Title is the first positional after "create" that is neither a flag nor a flag's value,
    // so `calendar create --at <iso> "Standup"` still resolves the title to "Standup".
    const valueFlags = new Set(["--at", "--assignee", "--prompt", "--cron"]);
    const title =
      args.slice(1).find((arg, idx, all) => !arg.startsWith("--") && !valueFlags.has(all[idx - 1] ?? "")) ||
      "Untitled reminder";
    if (cron) {
      try {
        deps.parseCron(cron);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    const item: GuiCliCalendarItem = {
      id: `cal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      at: atIdx >= 0 && args[atIdx + 1] ? args[atIdx + 1] : new Date().toISOString(),
      cron,
      assignee: assigneeIdx >= 0 && args[assigneeIdx + 1] ? args[assigneeIdx + 1] : deps.defaultAgentId,
      prompt: promptIdx >= 0 && args[promptIdx + 1] ? args[promptIdx + 1] : undefined,
      created_at: Date.now(),
    };
    state.calendar.push(item);
    return `calendar created ${item.id}${cron ? ` cron=${cron}` : ""}`;
  }
  if (cmd === "delete") {
    const id = args[1];
    if (!id) return "usage: king-ai calendar delete <id>";
    const index = state.calendar.findIndex((item) => item.id === id);
    if (index < 0) return `calendar not found: ${id}`;
    state.calendar.splice(index, 1);
    return `calendar deleted ${id}`;
  }
  return "usage: king-ai calendar list|create|delete <title> --at <iso> [--cron expr] [--assignee <id>] [--prompt <text>] | delete <id>";
}
