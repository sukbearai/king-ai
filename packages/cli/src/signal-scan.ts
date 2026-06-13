import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.js";
import { SIGNAL_ALERT_LOG_PATH, SIGNAL_OUTPUT_DIR } from "./paths.js";
import { sendTelegram } from "./trade/telegram.js";
import type { TokenSignal } from "./signal-engine.js";
import {
  SignalEngine,
  buildSignalSources,
  formatScanResult,
  type ScanResult,
  type SignalCategory,
  type SignalSource
} from "./signal-engine.js";

export interface SignalScanOptions {
  threshold?: number;
  sources?: SignalCategory[];
  dryRun?: boolean;
  alertLogPath?: string;
  outputDir?: string;
  json?: boolean;
  weightOverrides?: Partial<Record<SignalCategory, number>>;
  pushTg?: boolean;
  minPushScore?: number;
  pushCooldownSec?: number;
}

const PUSH_COOLDOWN_PATH = join(SIGNAL_OUTPUT_DIR, "push_cooldown.json");

function cooldownKey(sig: TokenSignal): string {
  const bucket = sig.score >= 0 ? "bull" : "bear";
  return `${sig.token}|${bucket}`;
}

async function loadPushCooldown(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(PUSH_COOLDOWN_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

async function savePushCooldown(state: Record<string, number>): Promise<void> {
  const now = Date.now() / 1000;
  const staleCutoff = now - 7 * 86400;
  const cleaned = Object.fromEntries(Object.entries(state).filter(([, v]) => v > staleCutoff));
  await mkdir(SIGNAL_OUTPUT_DIR, { recursive: true });
  await writeFile(PUSH_COOLDOWN_PATH, JSON.stringify(cleaned), "utf8");
}

function formatTgFusionMessage(sig: TokenSignal): string {
  const icons: Record<string, string> = {
    strong_buy: "🟢🟢 强买",
    buy: "🟢 偏买",
    strong_sell: "🔴🔴 强卖",
    sell: "🔴 偏卖"
  };
  const dirText = icons[sig.direction] ?? sig.direction;
  const lines = [`📡 SignalEngine 融合信号 — ${sig.symbol} ${dirText}`, `综合得分: ${sig.score >= 0 ? "+" : ""}${sig.score.toFixed(2)}`, ""];
  for (const s of sig.sources.slice(0, 5)) {
    const arrow = s.direction > 0 ? "↑" : s.direction < 0 ? "↓" : "→";
    lines.push(`  [${s.source}] ${arrow} ${s.direction >= 0 ? "+" : ""}${s.direction.toFixed(2)} (conf ${Math.round(s.confidence * 100)}%) ${s.detail.slice(0, 60)}`);
  }
  return lines.join("\n");
}

async function maybePushFusionSignals(
  result: ScanResult,
  options: SignalScanOptions
): Promise<void> {
  if (!options.pushTg || options.dryRun || !result.signals.length) return;
  const minScore = options.minPushScore ?? 0.5;
  const cooldownSec = options.pushCooldownSec ?? 7200;
  const cooldown = await loadPushCooldown();
  const now = Date.now() / 1000;
  let pushed = 0;

  for (const sig of result.signals) {
    if (Math.abs(sig.score) < minScore) continue;
    if (sig.sources.length < 2) continue;
    const key = cooldownKey(sig);
    if (now - (cooldown[key] ?? 0) < cooldownSec) continue;
    const ok = await sendTelegram(formatTgFusionMessage(sig));
    if (ok) {
      cooldown[key] = now;
      pushed++;
      process.stderr.write(`[push] ✓ ${sig.symbol} score=${sig.score >= 0 ? "+" : ""}${sig.score.toFixed(2)}\n`);
    }
  }
  if (pushed > 0) await savePushCooldown(cooldown);
}

const VALID_SOURCES: SignalCategory[] = ["smart_money", "technical", "social", "event", "meme"];

export function parseSourceList(raw: string): SignalCategory[] {
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean) as SignalCategory[];
  const unknown = ids.filter((id) => !VALID_SOURCES.includes(id));
  if (unknown.length) {
    throw new Error(`Unknown signal sources: ${unknown.join(", ")}. Available: ${VALID_SOURCES.join(", ")}`);
  }
  return ids;
}

export function buildEngine(options: SignalScanOptions): SignalEngine {
  const alertLogPath = options.alertLogPath ?? SIGNAL_ALERT_LOG_PATH;
  let sources: SignalSource[] | undefined;
  if (options.sources?.length) {
    sources = buildSignalSources(options.sources, alertLogPath);
  }
  return new SignalEngine({
    sources,
    alertLogPath,
    weightOverrides: options.weightOverrides
  });
}

export async function runSignalScan(options: SignalScanOptions = {}): Promise<ScanResult> {
  const engine = buildEngine(options);
  const result = await engine.scan();

  if (options.threshold && options.threshold > 0) {
    result.signals = result.signals.filter((s) => Math.abs(s.score) >= options.threshold!);
  }

  const output = formatScanResult(result);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }

  if (!options.dryRun && result.signals.length) {
    const outDir = options.outputDir ?? SIGNAL_OUTPUT_DIR;
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "latest_scan.txt"), output, "utf8");

    for (const sig of result.signals) {
      await appendJsonl(join(outDir, "signal_log.jsonl"), {
        token: sig.token,
        symbol: sig.symbol,
        score: sig.score,
        direction: sig.direction,
        sources: sig.sources.map((s) => ({
          source: s.source,
          direction: s.direction,
          confidence: s.confidence,
          detail: s.detail
        })),
        timestamp: new Date().toISOString()
      });
    }
  }

  await maybePushFusionSignals(result, options);
  return result;
}

export async function runSignalScanLoop(
  intervalSec: number,
  options: SignalScanOptions = {}
): Promise<void> {
  const sourceLabel = options.sources?.length
    ? options.sources.join(",")
    : "smart_money,technical,social,event,meme";
  process.stderr.write(
    `Signal scan loop — interval ${intervalSec}s, threshold ${options.threshold ?? 0}, sources ${sourceLabel}\n`
  );

  for (;;) {
    await runSignalScan(options);
    process.stdout.write(`\n${"─".repeat(40)}\n下次扫描: ${intervalSec}s 后\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}