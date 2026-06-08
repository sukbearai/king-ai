export const STANDARD_ARTIFACT_KINDS = new Set([
  "competitor",
  "market_data",
  "customer_profile",
  "location_data",
  "budget_item",
  "revenue_forecast",
  "financial_summary",
  "brand_asset",
  "content_plan",
  "tech_spec"
]);

export const DEFAULT_ARTIFACT_AGENT_IDS = ["king-ai-ceo"] as const;

export type ArtifactQualityCheck = {
  valid: boolean;
  warnings: string[];
  score: number;
};

export type ArtifactCandidate = {
  kind: string;
  path: string;
  source: string;
  confidence: number;
  metadata: Record<string, unknown>;
  content?: string;
};

export type ArtifactLike = ArtifactCandidate & {
  id: string;
  agentId: string;
  taskId?: string;
  verified: boolean;
  created_at: number;
};

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function isThreePartArtifactPath(pathValue: string): boolean {
  return pathValue.split("/").filter(Boolean).length >= 3;
}

function isKnownArtifactSource(source: string): boolean {
  return source === "training_data" ||
    source === "estimate" ||
    source.startsWith("web_search:") ||
    source === "government_data" ||
    source === "industry_report" ||
    source.startsWith("api:") ||
    source === "cross_validated" ||
    source === "marketing" ||
    DEFAULT_ARTIFACT_AGENT_IDS.includes(source as typeof DEFAULT_ARTIFACT_AGENT_IDS[number]) ||
    source === "original";
}

function hasMetadataDate(metadata: Record<string, unknown>): boolean {
  return typeof metadata.collected_at === "string" ||
    typeof metadata.collectedAt === "string" ||
    typeof metadata.date === "string" ||
    typeof metadata.verified_at === "string" ||
    typeof metadata.verifiedAt === "string";
}

function requiresUnits(kind: string, pathValue: string, metadata: Record<string, unknown>): boolean {
  const financial = kind === "budget_item" ||
    kind === "revenue_forecast" ||
    kind === "financial_summary" ||
    pathValue.startsWith("costs/") ||
    pathValue.startsWith("revenue/") ||
    pathValue.startsWith("finance/");
  if (!financial) return false;
  return typeof metadata.currency !== "string" &&
    typeof metadata.unit !== "string" &&
    typeof metadata.period !== "string";
}

export function checkArtifactQuality(artifact: ArtifactCandidate): ArtifactQualityCheck {
  const warnings: string[] = [];
  if (!STANDARD_ARTIFACT_KINDS.has(artifact.kind)) warnings.push(`non-standard kind: ${artifact.kind}`);
  if (!isThreePartArtifactPath(artifact.path)) warnings.push("path should use domain/category/item");
  if (!isKnownArtifactSource(artifact.source)) warnings.push(`source is not a recognized identifier: ${artifact.source}`);
  if (artifact.source === "training_data" && artifact.confidence > 0.3) warnings.push("training_data confidence should be <= 0.3");
  if (artifact.source === "estimate" && artifact.confidence > 0.5) warnings.push("estimate confidence should be <= 0.5");
  if (artifact.source.startsWith("web_search:") && artifact.confidence > 0.7 && artifact.metadata.source !== "cross_validated") {
    warnings.push("single web_search confidence should be <= 0.7 unless cross_validated");
  }
  if ((artifact.source === "government_data" || artifact.source === "cross_validated") && artifact.confidence < 0.8) {
    warnings.push(`${artifact.source} usually deserves confidence >= 0.8`);
  }
  if (!hasMetadataDate(artifact.metadata)) warnings.push("metadata should include collection date or verified_at");
  if (requiresUnits(artifact.kind, artifact.path, artifact.metadata)) warnings.push("metadata should include units such as currency, period, or unit");
  if (artifact.kind === "brand_asset" && !artifact.content && typeof artifact.metadata.name !== "string") {
    warnings.push("brand_asset should include content or metadata.name");
  }
  return {
    valid: warnings.length === 0,
    warnings,
    score: Math.max(0, roundScore(1 - warnings.length * 0.12))
  };
}

export function formatArtifactQualityCheck(check: ArtifactQualityCheck): string {
  return [
    `artifact quality valid=${check.valid} score=${formatNumber(check.score)}`,
    ...(check.warnings.length ? check.warnings.map((warning) => `- ${warning}`) : ["- no warnings"])
  ].join("\n");
}

export function parseMetadataJson(args: string[]): Record<string, unknown> | null {
  const optionsWithValue = new Set(["--kind", "--path", "--source", "--confidence", "--task", "--content", "--agent"]);
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] || "";
    if (optionsWithValue.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--allow-nonstandard" || arg === "--unverified") continue;
    positionals.push(arg);
  }
  const raw = positionals.at(-1);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function artifactCandidateFromArgs(
  args: string[],
  readOption: (args: string[], flag: string) => string | undefined
): ArtifactCandidate | null {
  const kind = readOption(args, "--kind");
  const path = readOption(args, "--path");
  const source = readOption(args, "--source");
  const confidence = Number.parseFloat(readOption(args, "--confidence") || "");
  if (!kind || !path || !source || !Number.isFinite(confidence)) return null;
  return {
    kind,
    path,
    source,
    confidence,
    metadata: parseMetadataJson(args) ?? {},
    content: readOption(args, "--content")
  };
}

export function findArtifactInState<S extends { artifacts: Array<{ id: string }> }>(
  state: S,
  id: string | undefined
): S["artifacts"][number] | undefined {
  if (!id) return undefined;
  return state.artifacts.find((artifact) => artifact.id === id || artifact.id.startsWith(id));
}

export function formatArtifactLine(artifact: Pick<ArtifactLike, "id" | "kind" | "path" | "source" | "confidence" | "taskId" | "verified">): string {
  const task = artifact.taskId ? ` task=${artifact.taskId}` : "";
  const verification = artifact.verified ? "verified" : "unverified";
  return `[${verification}] ${artifact.id.slice(0, 14)} ${artifact.kind} ${artifact.path} source=${artifact.source} confidence=${artifact.confidence}${task}`;
}
