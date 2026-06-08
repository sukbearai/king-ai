export type GuiCliClaim = {
  id: string;
  name: string;
  conversationId?: string;
  owner: string;
  allowedPaths?: string[];
  created_at: number;
};

export type GuiCliClaimActor = { id: string };

export type RunClaimCommandDeps<S extends { claims: GuiCliClaim[] }> = {
  parseAllowedPaths: (args: string[]) => string[];
  readOption: (args: string[], flag: string) => string | undefined;
  pathConflict: (state: S, paths: string[], owner: string, excludeClaimId?: string) => string | null | undefined;
};

export function runClaimCommand<S extends { claims: GuiCliClaim[] }>(
  state: S,
  args: string[],
  actor: GuiCliClaimActor,
  deps: RunClaimCommandDeps<S>
): string {
  const name = args[0] || "work";
  const inIdx = args.indexOf("--in");
  const conversationId = inIdx >= 0 ? args[inIdx + 1] : undefined;
  const owner = deps.readOption(args, "--owner") || actor.id;
  const allowedPaths = deps.parseAllowedPaths(args);
  const conflict = deps.pathConflict(state, allowedPaths, owner);
  if (conflict) return `path conflict: ${conflict}`;
  const existing = state.claims.find((claim) => claim.name === name && claim.conversationId === conversationId);
  if (existing && existing.owner !== owner) return `claim held by ${existing.owner}`;
  if (existing) return `claim already held ${existing.id}`;
  const claim: GuiCliClaim = {
    id: `claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    conversationId,
    owner,
    allowedPaths,
    created_at: Date.now()
  };
  state.claims.push(claim);
  return `claim created ${claim.id}${allowedPaths.length ? ` paths=${allowedPaths.join(",")}` : ""}`;
}

export function runUnclaimCommand<S extends { claims: GuiCliClaim[] }>(state: S, args: string[]): string {
  const id = args[0];
  const before = state.claims.length;
  state.claims = state.claims.filter((claim) => claim.id !== id && claim.name !== id);
  return state.claims.length < before ? "claim released" : `claim not found: ${id}`;
}
