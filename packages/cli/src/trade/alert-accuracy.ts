import { AccuracyTracker } from "./accuracy-tracker.js";

export async function runAccuracyCycle(options: {
  days?: number;
  showStats?: boolean;
} = {}): Promise<string | null> {
  const tracker = new AccuracyTracker();
  const ingested = await tracker.ingestAlerts(options.days ?? 30);
  process.stderr.write(`[alert-accuracy] ingested ${ingested}\n`);
  const result = await tracker.validatePending();
  process.stderr.write(
    `[alert-accuracy] validated ${result.updated}/${result.checked} (${result.token_updated} token)\n`
  );
  const overrides = await tracker.updateSignalWeights();
  if (Object.keys(overrides).length) {
    process.stderr.write(`[alert-accuracy] weight overrides ${JSON.stringify(overrides)}\n`);
  }
  if (options.showStats === false) return null;
  return tracker.formatStats(options.days ?? 30);
}