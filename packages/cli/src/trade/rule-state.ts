import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TRADE_RULE_STATE_PATH } from "../paths.js";
import { todayDisplayDate } from "./time-utils.js";

export interface RuleStateFile {
  cooldowns: Record<string, number>;
  dailyPushCounts: Record<string, number>;
  dailyPushDate: string;
  recentSignals: Array<{
    ruleKey: string;
    symbol: string;
    direction: string;
    severity: string;
    ts: number;
    volState: string;
  }>;
  heartbeats: Record<string, { ruleName: string; lastCheck: number; status: string; durationMs: number }>;
}

const DEFAULT_STATE: RuleStateFile = {
  cooldowns: {},
  dailyPushCounts: {},
  dailyPushDate: todayDisplayDate(),
  recentSignals: [],
  heartbeats: {},
};

const writeChains = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  writeChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export class RuleStateStore {
  constructor(private readonly path = TRADE_RULE_STATE_PATH) {}

  private async readState(): Promise<RuleStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as RuleStateFile;
      const today = todayDisplayDate();
      if (raw.dailyPushDate !== today) {
        raw.dailyPushCounts = {};
        raw.dailyPushDate = today;
      }
      return { ...DEFAULT_STATE, ...raw };
    } catch {
      return { ...DEFAULT_STATE, dailyPushDate: todayDisplayDate() };
    }
  }

  private async writeState(state: RuleStateFile): Promise<void> {
    await withLock(this.path, async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tmp, this.path);
    });
  }

  async update(mutator: (state: RuleStateFile) => void): Promise<RuleStateFile> {
    const state = await this.readState();
    mutator(state);
    await this.writeState(state);
    return state;
  }

  async getDailyPushCount(rule: string): Promise<number> {
    const state = await this.readState();
    return state.dailyPushCounts[rule] ?? 0;
  }

  async incrementDailyPushCount(rule: string): Promise<void> {
    await this.update((state) => {
      state.dailyPushCounts[rule] = (state.dailyPushCounts[rule] ?? 0) + 1;
    });
  }

  async recordSignal(
    ruleKey: string,
    symbol: string,
    direction: string,
    severity: string,
    volState = "normal",
  ): Promise<void> {
    const now = Date.now() / 1000;
    await this.update((state) => {
      state.recentSignals.push({ ruleKey, symbol, direction, severity, ts: now, volState });
      state.recentSignals = state.recentSignals.filter((s) => s.ts > now - 3600);
    });
  }

  async loadAlertCooldowns(): Promise<Record<string, number>> {
    const state = await this.readState();
    return { ...state.cooldowns };
  }

  async saveAlertCooldowns(cooldowns: Record<string, number>): Promise<void> {
    await this.update((state) => {
      state.cooldowns = { ...cooldowns };
    });
  }

  async checkConfluence(
    symbol: string,
    windowSeconds = 900,
  ): Promise<Array<{ ruleKey: string; direction: string; severity: string; volState: string }>> {
    const state = await this.readState();
    const cutoff = Date.now() / 1000 - windowSeconds;
    const rows = state.recentSignals.filter((s) => s.symbol === symbol && s.ts > cutoff);
    const distinct = new Set(rows.map((r) => r.ruleKey));
    if (distinct.size < 2) return [];
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = `${r.ruleKey}|${r.direction}`;
      if (seen.has(r.ruleKey)) return false;
      seen.add(r.ruleKey);
      return true;
    });
  }
}

let singleton: RuleStateStore | null = null;

export function getRuleStateStore(): RuleStateStore {
  if (!singleton) singleton = new RuleStateStore();
  return singleton;
}
