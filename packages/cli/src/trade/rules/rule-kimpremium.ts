import { createAlert, type Alert, type AlertRule } from "../alert-rule.js";
import { loadTradeConfig, type TradeConfig } from "../config.js";
import { nowDisplay } from "../data-helpers.js";
import {
  assessKimpremiumSnapshot,
  buildKimpremiumSnapshot,
  type KimpremiumConfig,
  type KimpremiumFileState,
  type KimpremiumSnapshot,
  KimpremiumStateStore,
  parseKimpremiumConfig,
} from "../kimpremium.js";

interface CreateKimpremiumRuleOptions {
  config?: TradeConfig;
  fetchFn?: typeof fetch;
  now?: () => Date;
  stateStore?: KimpremiumStateStore;
}

function snapshotId(snapshot: KimpremiumSnapshot): string {
  return `${snapshot.asof}|${snapshot.generated}|${snapshot.etfAsof}`;
}

function shouldPoll(state: KimpremiumFileState, config: KimpremiumConfig, now: Date): boolean {
  if (!state.lastCheckedAt) return true;
  const elapsed = now.getTime() - Date.parse(state.lastCheckedAt);
  return !Number.isFinite(elapsed) || elapsed >= config.pollSeconds * 1000;
}

async function fetchObject(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    headers: { "User-Agent": "king-ai-trade/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${url} returned invalid JSON`);
  return body as Record<string, unknown>;
}

async function fetchSnapshot(fetchFn: typeof fetch, config: KimpremiumConfig, now: Date): Promise<KimpremiumSnapshot> {
  const [meta, series, etf] = await Promise.all([
    fetchObject(fetchFn, `${config.baseUrl}/data/meta.json`, config.requestTimeoutMs),
    fetchObject(fetchFn, `${config.baseUrl}/data/series.json`, config.requestTimeoutMs),
    fetchObject(fetchFn, `${config.baseUrl}/data/etf.json`, config.requestTimeoutMs),
  ]);
  return buildKimpremiumSnapshot(meta, series, etf, config.baseUrl, now);
}

function formatMetric(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function buildAlertDetail(
  snapshot: KimpremiumSnapshot,
  assessment: ReturnType<typeof assessKimpremiumSnapshot>,
): string {
  const m = snapshot.metrics;
  const lines = [
    `数据日: ${snapshot.asof} | 生成时间: ${snapshot.generated}（韩国时间）`,
    `强平分位 ${formatMetric(m.liqPct)}% | 强平/未偿 ${formatMetric(m.liqR, 2)}% | R2 分位 ${formatMetric(m.r2Pct)}%`,
    `额度使用 ${formatMetric(m.util)}% | 市值/GDP 分位 ${formatMetric(m.mgPct)}% | 杠杆温度 ${formatMetric(m.thermo, 2)}%`,
    "触发原因：",
    ...assessment.issues.slice(0, 6).map((issue) => `· [${issue.severity}] ${issue.reason}`),
    `数据源: ${snapshot.sourceUrl}`,
  ];
  return lines.join("\n");
}

function sourceFailureAlert(streak: number, severity: "warning" | "critical", message: string): Alert {
  return createAlert({
    ruleId: "kimpremium",
    severity,
    title: `Kimpremium 数据源连续失败 ${streak} 次`,
    detail: [`三个业务 JSON 未能完成本轮采集：${message}`, "本轮不计算 KPI 风险，避免使用旧数据误判。"].join("\n"),
    direction: 0,
    strength: severity === "critical" ? 1 : 0.6,
    tags: ["macro", "korea", "source-health", "regime_gated"],
  });
}

export function createRuleKimpremium(options: CreateKimpremiumRuleOptions = {}): AlertRule {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const stateStore = options.stateStore ?? new KimpremiumStateStore();
  let heartbeatStatus: "ok" | "degraded" | "error" = "ok";

  return {
    name: "kimpremium_leverage",
    ruleKey: "kimpremium",
    defaultCooldown: 86_400,
    heartbeatStatus: () => heartbeatStatus,
    async check(): Promise<Alert[]> {
      const tradeConfig = options.config ?? (await loadTradeConfig());
      const config = parseKimpremiumConfig(tradeConfig);
      const checkedAt = now();
      const fileState = await stateStore.load();
      if (!shouldPoll(fileState, config, checkedAt)) return [];
      fileState.lastCheckedAt = checkedAt.toISOString();

      let snapshot: KimpremiumSnapshot;
      try {
        snapshot = await fetchSnapshot(fetchFn, config, checkedAt);
      } catch (err) {
        fileState.failureStreak += 1;
        heartbeatStatus = fileState.failureStreak >= 2 ? "error" : "degraded";
        const severity = fileState.failureStreak >= 3 ? "critical" : "warning";
        const shouldAlert = fileState.failureStreak >= 2 && fileState.lastSourceAlertLevel !== severity;
        if (shouldAlert) fileState.lastSourceAlertLevel = severity;
        await stateStore.save(fileState);
        if (!shouldAlert) return [];
        const message = err instanceof Error ? err.message : String(err);
        return [sourceFailureAlert(fileState.failureStreak, severity, message)];
      }

      heartbeatStatus = "ok";
      const previousId = fileState.lastSnapshot ? snapshotId(fileState.lastSnapshot) : "";
      const currentId = snapshotId(snapshot);
      fileState.failureStreak = 0;
      delete fileState.lastSourceAlertLevel;
      if (currentId === previousId) {
        await stateStore.save(fileState);
        return [];
      }

      const assessment = assessKimpremiumSnapshot(snapshot, config, checkedAt);
      const alertKey = `${snapshot.asof}:${assessment.severity ?? "normal"}`;
      const shouldAlert = assessment.severity != null && fileState.lastAlertKey !== alertKey;
      let alert: Alert | null = null;
      if (shouldAlert) {
        alert = createAlert({
          ruleId: "kimpremium",
          severity: assessment.severity!,
          title: assessment.severity === "critical" ? "韩国杠杆风险进入极高区" : "韩国杠杆风险升温",
          detail: buildAlertDetail(snapshot, assessment),
          timestamp: nowDisplay(),
          direction: -1,
          strength: assessment.severity === "critical" ? 1 : 0.65,
          asset: "KOSPI",
          tags: ["macro", "korea", "leverage", "regime_gated"],
        });
      }

      fileState.lastSnapshot = snapshot;
      fileState.lastAlertKey = alertKey;
      await stateStore.appendSnapshot(snapshot);
      await stateStore.save(fileState);
      return alert ? [alert] : [];
    },
  };
}
