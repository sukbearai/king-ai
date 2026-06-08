export type GuiCliArtifact = {
  id: string;
  kind: string;
  path: string;
  source: string;
  confidence: number;
  agentId: string;
  taskId?: string;
  content?: string;
  metadata: Record<string, unknown>;
  verified: boolean;
  created_at: number;
};

export type GuiCliArtifactQualityCheck = {
  valid: boolean;
  warnings: string[];
  score: number;
};

export type GuiCliArtifactActor = { id: string };

export type RunArtifactCommandDeps<
  S extends { artifacts: GuiCliArtifact[] },
  A extends GuiCliArtifact
> = {
  readOption: (args: string[], flag: string) => string | undefined;
  standardArtifactKinds: ReadonlySet<string>;
  findArtifact: (state: S, id: string | undefined) => A | undefined;
  artifactCandidateFromArgs: (args: string[]) => Pick<A, "kind" | "path" | "source" | "confidence" | "metadata" | "content"> | null;
  checkArtifactQuality: (artifact: Pick<A, "kind" | "path" | "source" | "confidence" | "metadata" | "content">) => GuiCliArtifactQualityCheck;
  formatArtifactQualityCheck: (check: GuiCliArtifactQualityCheck) => string;
  parseMetadataJson: (args: string[]) => Record<string, unknown> | null;
  formatArtifactLine: (artifact: A) => string;
  pushLoopEvent: (state: S, event: Record<string, unknown>) => void;
};

export function runArtifactCommand<
  S extends { artifacts: GuiCliArtifact[] },
  A extends GuiCliArtifact,
  Actor extends GuiCliArtifactActor
>(state: S, args: string[], actor: Actor, deps: RunArtifactCommandDeps<S, A>): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const agent = deps.readOption(args, "--agent");
    const kind = deps.readOption(args, "--kind");
    const unverified = args.includes("--unverified");
    const rows = state.artifacts.filter((artifact) =>
      (!agent || artifact.agentId === agent) &&
      (!kind || artifact.kind === kind) &&
      (!unverified || !artifact.verified)
    ) as A[];
    if (rows.length === 0) return "No artifacts found.";
    return rows.map((artifact) => deps.formatArtifactLine(artifact)).join("\n") + `\n\n${rows.length} artifact(s)`;
  }
  if (cmd === "get") {
    const artifact = deps.findArtifact(state, args[1]);
    return artifact ? JSON.stringify(artifact, null, 2) : `artifact not found: ${args[1] || ""}`;
  }
  if (cmd === "check") {
    const existing = deps.findArtifact(state, args[1]);
    const candidate = existing ?? deps.artifactCandidateFromArgs(args);
    if (!candidate) {
      return "usage: king-ai artifact check <id> OR king-ai artifact check --kind <kind> --path <domain/category/item> --source <source> --confidence <0-1>";
    }
    const check = deps.checkArtifactQuality(candidate);
    return deps.formatArtifactQualityCheck(check);
  }
  if (cmd === "put") {
    const kind = deps.readOption(args, "--kind");
    const path = deps.readOption(args, "--path");
    const source = deps.readOption(args, "--source");
    const confidence = Number.parseFloat(deps.readOption(args, "--confidence") || "");
    if (!kind || !path || !source || !Number.isFinite(confidence)) {
      return "usage: king-ai artifact put --kind <kind> --path <domain/category/item> --source <source> --confidence <0-1> [--task id] [--content text] '<metadata json>'";
    }
    if (confidence < 0 || confidence > 1) return "artifact confidence must be between 0 and 1";
    const allowNonstandard = args.includes("--allow-nonstandard");
    if (!deps.standardArtifactKinds.has(kind) && !allowNonstandard) {
      return `non-standard artifact kind: ${kind}. Use --allow-nonstandard to store it anyway.`;
    }
    const metadata = deps.parseMetadataJson(args) ?? {};
    if (!deps.standardArtifactKinds.has(kind)) metadata.non_standard_kind = true;
    const quality = deps.checkArtifactQuality({ kind, path, source, confidence, metadata, content: deps.readOption(args, "--content") });
    if (quality.warnings.length) metadata.quality_warnings = quality.warnings;
    metadata.quality_score = quality.score;
    const artifact = {
      id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind,
      path,
      source,
      confidence,
      agentId: deps.readOption(args, "--agent") || actor.id,
      taskId: deps.readOption(args, "--task"),
      content: deps.readOption(args, "--content"),
      metadata,
      verified: confidence >= 0.8,
      created_at: Date.now()
    } as A;
    state.artifacts.push(artifact);
    deps.pushLoopEvent(state, {
      type: "artifact.created",
      agent: artifact.agentId,
      taskId: artifact.taskId,
      kind: artifact.kind,
      path: artifact.path,
      payload: { artifactId: artifact.id, confidence: artifact.confidence, verified: artifact.verified }
    });
    return `artifact stored ${artifact.id} kind=${artifact.kind} source=${artifact.source} confidence=${artifact.confidence}${quality.warnings.length ? ` warnings=${quality.warnings.length}` : ""}`;
  }
  return "usage: king-ai artifact put|list|get|check";
}
