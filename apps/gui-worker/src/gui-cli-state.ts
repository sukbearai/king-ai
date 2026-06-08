export type RunStateCommandDeps<S> = {
  snapshot: (state: S) => unknown;
  importSnapshot: (payload: unknown) => Promise<Response>;
  resetState: () => Promise<Response>;
};

export async function runStateCommand<S>(state: S, args: string[], deps: RunStateCommandDeps<S>): Promise<string> {
  const cmd = args[0] || "export";
  if (cmd === "export") return JSON.stringify(deps.snapshot(state), null, 2);
  if (cmd === "import") {
    const raw = args.slice(1).join(" ").trim();
    if (!raw) return "usage: king-ai state import '<snapshot json>'";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return `invalid snapshot JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    const res = await deps.importSnapshot(payload);
    return await res.text();
  }
  if (cmd === "reset") {
    const res = await deps.resetState();
    return await res.text();
  }
  return "usage: king-ai state export|import|reset";
}
