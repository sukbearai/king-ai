# 交易信号（Trade）

`king-ai trade` 是**本地市场情报 sensor/daemon**（不是 multi-agent 协作工作流）。它在单一 supervisor 中运行告警规则、晨报、Twitter 采集和看门狗。栈为 **OpenCLI + tg + 本地 agent + Yahoo**，默认七条规则使用稳定 id：`treasury`、`meme_large`、`stocks`、`celebrity`、`ticker_velocity`、`discord_wba`、`panews`；`kimpremium` 韩国杠杆风险规则需要显式启用。

Trade 与多 agent 协作共享 `~/.king-ai` 与本地 agent CLI，但**不共享** task/card/host 工作流状态机。

## 快速开始

复制示例配置并安装后台服务：

```sh
mkdir -p ~/.king-ai
cp path/to/trade_config.example.json ~/.king-ai/trade_config.json
# 编辑 telegram bot_token、push_chat_id、llm 密钥、自选股等

king-ai trade install-service --push-tg
king-ai trade status
```

`install-service` 会注册 `dev.king-ai-trade`（macOS LaunchAgent 或 Linux systemd 用户单元）并启动 daemon。

前台调试：

```sh
king-ai trade daemon --push-tg
```

同一时间只应有**一个** trade daemon。进程会写入 `~/.king-ai/trade/state/daemon.pid`，拒绝第二个仍存活的实例。

## 配置

主配置文件：`~/.king-ai/trade_config.json`（可用 `KING_AI_TRADE_CONFIG` 覆盖）。JSON 非法时 daemon **启动失败**；文件缺失则使用内置默认值。

常用路径：

```text
~/.king-ai/trade_config.json
~/.king-ai/trade/logs/daemon.log
~/.king-ai/trade/scratchpad.json
~/.king-ai/trade/rule_state.json
~/.king-ai/trade/state/daemon.pid
~/.king-ai/trade/state/kimpremium_latest.json
~/.king-ai/trade/state/kimpremium_snapshots.jsonl
~/.king-ai/trade/skills/panews/cli.mjs
```

告警审计日志与 Twitter 缓存：

```text
~/.king-ai/trade/alerts/alert_log.jsonl
~/.king-ai/trade/state/twitter_cache.jsonl
```

主要配置段：

| 配置段 | 作用 |
|--------|------|
| `alerts.enabled` | 稳定规则 id（默认完整 slim 栈）；旧字母 id 仍可用 |
| `alerts.poll_seconds` | 统一规则轮询间隔（默认 `120`） |
| `alerts.tick_timeout_ms` | daemon 全局单规则 tick 超时（设置后覆盖各规则默认） |
| `alerts.llm_advice` | 为所有最终推送的 warning/critical Telegram 告警追加面向初学者的 LLM 风险建议（默认 `false`） |
| `alerts.confluence.enabled` | 多规则对同一**非空** asset 共振时将 info 升为 warning（默认 `true`）。旧键：`alerts.confluence_enabled` |
| `alerts.confluence.window_seconds` | 共振窗口秒数（默认 `900`）。旧键：`alerts.confluence_window_seconds` |
| `alerts.rule_stagger_ms` | 一轮中规则间隔毫秒（默认 `1000`） |
| `briefing.enabled` | 晨报板块 |
| `briefing.schedule_hour` | 晨报 cron 小时（本地，默认 `5`） |
| `verify.step_timeout_ms` | `verify-tg` 单源超时（设置后覆盖规则默认） |
| `data_sources.pumpfun` / `leaderboard` | 链上晨报板块 |
| `treasury` | 美债抛售 / 收益率阈值 |
| `kimpremium` | 韩国杠杆 KPI、采集间隔和阈值（默认不启用） |
| `alerts.celebrity_tweet.max_classifications_per_tick` | 每轮名人推文最多 LLM 分类数（默认 `8`，范围 `1..50`） |
| `llm.disabled_backends` | 从回退链排除的本地 agent 后端，例如 `["claude"]` |
| `llm.agent_tasks.<task>.backend` | 可选任务后端；空值或缺失时依次继承 `llm.default_backend`、`llm.provider`、Codex |
| `llm.agent_tasks.<task>.timeout_ms` | 可选的单任务本地 agent 超时 |
| `telegram` | `bot_token` 与 `push_chat_id` |

仓库内模板见 `packages/cli/trade_config.example.json`。

## 告警规则

列出已注册规则（稳定 id + legacy + 展示名）：

```sh
king-ai trade alert list
```

单次运行（可用稳定 id 或 legacy id）：

```sh
king-ai trade alert run panews --once
king-ai trade alert run q --once
king-ai trade alert run ticker_velocity --once --push-tg
```

| 稳定 ID | Legacy | 监控内容 |
|---------|--------|----------|
| `treasury` | `b` | 美债抛售 / 收益率（`^TYX` 30Y、`TLT` 价格，Yahoo） |
| `meme_large` | `e` | Meme 大单（`tg` meme链上监控） |
| `stocks` | `f` | 自选股涨跌（OpenCLI/Yahoo） |
| `celebrity` | `t` | 名人推文 alpha（默认 Trump/Musk/CZ） |
| `ticker_velocity` | `tm` | Twitter ticker 提及加速 |
| `panews` | `q` | PANews 事件（本地 agent 分类） |
| `discord_wba` | — | Discord WBA 频道（OpenCLI browser） |
| `kimpremium` | — | 韩国散户杠杆 KPI、日变化与历史波动分位（opt-in） |

### 告警流水线

```text
rule.check → regime 降级 → 共振（仅 asset）→ JSONL 审计 → TG 严重度门槛 → 日 cap（按 ruleId）→ 可选 LLM 建议 → 推送
```

- `info` 级始终写 JSONL；Telegram 默认只推 `warning` 及以上。
- 日推 cap 与 cooldown 按**稳定 `ruleId`** 计数，不再使用中文展示名当 key。
- 共振只看非空 `asset`（大写规范化），不再用 title 首词猜测。
- daemon 每条规则有 tick 超时（如 celebrity `240s`、panews `120s`）；超时记 heartbeat `timeout` 并继续下一规则。
- cooldown 持久化在 `~/.king-ai/trade/rule_state.json`。

名人 alpha 为 **LLM 全自动判定**（无人工审批）：本地 agent 决定 `is_alpha` / `alpha_type` / `confidence` / `entities`。任务后端为空或缺失时依次继承 `llm.default_backend`、`llm.provider`、Codex，并跳过 `llm.disabled_backends` 中的后端；选择 Codex 时使用只读且不依赖 daemon 当前目录的调用。每轮默认最多分类 8 条候选，成功判定为非 alpha 后静默 6 小时。JSON 解析失败按 15、30、60 分钟退避并继续重试。X 采集的登录、挑战、采集失败和本地 agent 后端全部耗尽会记录为 heartbeat 错误，不再伪装成健康的无告警；Telegram 投递失败会在告警审计写入后记录日志。

### Kimpremium 杠杆风险

首版只读取 `meta.json`、`series.json` 和 `etf.json`，不启动 Chrome。把 `kimpremium` 加入 `alerts.enabled` 后，规则按 `kimpremium.poll_seconds`（默认 `300`）采集；同一 `asof/generated` 不重复写快照或推送。水平阈值与前 252 个交易日的日变化分位共同判断风险，连续 2/3 次源站失败分别触发 warning/critical。

### 所有 Telegram 告警的 LLM 建议

`alerts.llm_advice=true` 时，每种规则最终通过 Telegram 严重度门槛和日 cap 的 warning/critical 告警，都会按本次发送批次调用一次 `llm.agent_tasks.alert_advice`。消息会附加面向初学者的风险解释，以及保守、中性、激进三种行动框架。源站健康故障不会调用建议，因为旧数据或缺失数据不能产生投资动作。

代码拒绝保证收益、确定性涨跌、满仓/梭哈和具体证券的立即买卖指令；模型不可用、执行异常或输出不合规时改用确定性本地解释，事实告警本身不会丢失。这些内容不知道用户持仓与承受能力，不构成个性化投资建议。

```json
{
  "alerts": { "enabled": ["treasury", "kimpremium"], "llm_advice": true },
  "kimpremium": { "poll_seconds": 300 },
  "llm": { "agent_tasks": { "alert_advice": { "timeout_ms": 45000 } } }
}
```

## Daemon Supervisor

daemon 使用统一规则调度器，并运行：

- 晨报（`briefing.schedule_hour`）
- regime 检测
- Twitter 采集与看门狗

晨报 Telegram 投递会在 `~/.king-ai/trade/logs/daemon.log` 写入
`[morning-brief] telegram push ok|failed chunks=N`，最近一次投递元数据在
`~/.king-ai/trade/scratchpad.json` 的 `last_brief_push`。

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
```

## 辅助命令

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade verify-tg --dry-run
king-ai trade verify-celebrity --dry-run
king-ai trade watchdog --kill
king-ai trade signal-quality
king-ai trade signal-quality --days 14 --json
king-ai trade signal-quality --refresh
```

### 信号质量（signal-quality）

`king-ai trade signal-quality` 读取告警 JSONL 审计日志（`~/.king-ai/trade/alerts/alert_log.jsonl`），用 OKX 1 小时 K 线计算 T+4h / T+24h 前向收益，按规则评估命中率与 edge。

| 标志 | 含义 |
|------|------|
| `--days N` | 回看天数（默认 `30`）。仅统计早于 25 小时的告警，确保 T+24h 结果已存在 |
| `--json` | 输出机器可读 JSON，而不是纯文本表 |
| `--refresh` | 重算全部结果并重写 `~/.king-ai/trade/state/signal_outcomes.jsonl` |

表格按 **`rule_id`** 聚合，并附 `TOTAL` 行：

| 列 | 含义 |
|----|------|
| `alerts` | 窗口内合格审计行（`asset` 非空） |
| `pushed` | 严重度为 `warning` 或 `critical` 的行 |
| `priced%` | 成功匹配 OKX K 线的占比 |
| `hit4h%` / `hit24h%` | 方向命中率（多：收益 &gt; 0；空：收益 &lt; 0；`direction == 0` 不计入） |
| `edge4h` / `edge24h` | 有方向样本上 `sign(direction) * return%` 的均值 |

未知标的（无 OKX K 线）记为 `unpriced`，计入 `alerts` 但不进入 hit/edge。结果缓存在 `signal_outcomes.jsonl`，再次运行只补算新 key；加 `--refresh` 可全量重算。

`verify-tg` 会各跑一遍当前启用的告警规则和晨报板块；超时工具与 daemon 共用。未设置 `verify.step_timeout_ms` 时按规则默认预算（名人推更长）。摘要与 PANews 分类走配置的本地 agent 链，默认优先 Codex，并跳过 `llm.disabled_backends` 中的后端。

`verify-celebrity --dry-run` 只检查 X 搜索页状态，不调 LLM、不推 Telegram；`unknown` 表示搜索页已加载但没有识别到推文或无结果标记，会作为 warning 展示，登录、挑战和真正错误仍会让健康检查失败。

市场晨报会并发请求 OKX 现货/合约接口，并使用较短的单请求预算。加密行情会显示带正负号的 24 小时涨跌幅，并在持仓量后标明币种单位。网络环境特殊时可用 `data_sources.market.request_timeout_ms` 和 `data_sources.market.fallback_timeout_ms` 调整新鲜度与晨报耗时之间的取舍。

市场、股票和美债行情在上游接口提供时会显示源行情时间。A 股指数按点位显示，港股使用 `HK$`；启用美债板块时，美债价格标的不会在股票自选列表重复出现。Yahoo 股票/美债行情遇到瞬时失败会重试一次；美债标的缺失时会显示降级提示，降息预期结论按配置的波动阈值生成，不再固定套用方向。

Twitter 采集器会对已登录的 `x.com/home` 虚拟时间线执行多轮下拉采样，并在 X 卸载旧 DOM 节点前跨轮合并推文。可用 `data_sources.twitter.collect_limit`、`scroll_rounds`、`scroll_wait_ms` 和 `stagnant_rounds` 调整覆盖量与采集耗时。采集日志会分别记录轮数、DOM 扫描量、唯一量、重复量、新增缓存、近 24 小时数量与作者数。这仍然是当前登录账号可见的主页流，不是 X 全量归档。

Twitter 晨报默认相关性过滤；板块标题显示「缓存→筛后→已分析」漏斗。LLM 模式的排序候选同时受 `data_sources.twitter.llm_max_display`（默认 `150`）、总量上限 `max_display` 和 `per_author_cap` 限制；非 LLM 展示仍使用 `max_display`。摘要最多输出 5 条，并保留作者、UTC+8 时间和原始链接的来源索引；摘要后会追加高互动原文速览，`data_sources.twitter.quick_list_size` 默认为 `10`，设为 `0` 可关闭。需要原始时间线时设 `data_sources.twitter.relevance_filter` 为 `false`。Telegram meme 摘要优先保留有价格依据的买卖、流动性、市值和集中度，并压缩、限制普通转账与空投列表；Chain.fm 原文引用的代币合约和缩写钱包会在确定性的地址索引中输出完整地址。启用 LLM 摘要时，`briefing.daily_summary` 默认为 `true`；至少两个板块成功后，会结合 scratchpad 当前市场状态输出最多三条跨板块要点和风险倾向。干跑预览不会覆盖最近一次定时或手动投递晨报的持久化元数据。

## OpenCLI Browser Bridge

```sh
opencli doctor
opencli browser trade-twitter --window background open https://x.com/home
opencli browser trade-twitter --window background wait selector article --timeout 30000
king-ai trade alert run stocks --once --dry-run
```

会话名：`trade-twitter`、`trade-twitter-search`、`trade-discord`。雪球不可用时回退 Yahoo Finance。

## 外部依赖

- `opencli` — Twitter/X、雪球、Discord
- `tg` — Telegram 频道
- `onchainos` — 可选聪明钱 / Pump.fun 晨报
- Yahoo Finance HTTP — 股票报价
- 本地 agent CLI（`grok`、`claude`、`codex`）— 摘要 / 分类 / 名人推解析

PANews：`~/.king-ai/trade/skills/panews/cli.mjs`。

## 开发

```sh
pnpm dev -- trade status
pnpm dev -- trade daemon --push-tg
pnpm dev -- trade verify-tg --dry-run
pnpm dev -- trade verify-celebrity --dry-run
```
