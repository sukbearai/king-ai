# 交易信号（Trade）

`king-ai trade` 是**本地市场情报 sensor/daemon**（不是 multi-agent 协作工作流）。它在单一 supervisor 中运行告警规则、晨报、Twitter 采集和看门狗。栈为 **OpenCLI + tg + 本地 agent + Yahoo**，七条规则使用稳定 id：`treasury`、`meme_large`、`stocks`、`celebrity`、`ticker_velocity`、`discord_wba`、`panews`。

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
| `alerts.confluence.enabled` | 多规则对同一**非空** asset 共振时将 info 升为 warning（默认 `true`）。旧键：`alerts.confluence_enabled` |
| `alerts.confluence.window_seconds` | 共振窗口秒数（默认 `900`）。旧键：`alerts.confluence_window_seconds` |
| `alerts.rule_stagger_ms` | 一轮中规则间隔毫秒（默认 `1000`） |
| `briefing.enabled` | 晨报板块 |
| `briefing.schedule_hour` | 晨报 cron 小时（本地，默认 `5`） |
| `verify.step_timeout_ms` | `verify-tg` 单源超时（设置后覆盖规则默认） |
| `data_sources.pumpfun` / `leaderboard` | 链上晨报板块 |
| `treasury` | 美债抛售 / 收益率阈值 |
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

### 告警流水线

```text
rule.check → regime 降级 → JSONL 审计 → 共振（仅 asset）→ TG 严重度门槛 → 日 cap（按 ruleId）→ 推送
```

- `info` 级始终写 JSONL；Telegram 默认只推 `warning` 及以上。
- 日推 cap 与 cooldown 按**稳定 `ruleId`** 计数，不再使用中文展示名当 key。
- 共振只看非空 `asset`（大写规范化），不再用 title 首词猜测。
- daemon 每条规则有 tick 超时（如 celebrity `240s`、panews `120s`）；超时记 heartbeat `timeout` 并继续下一规则。
- cooldown 持久化在 `~/.king-ai/trade/rule_state.json`。

名人 alpha 为 **LLM 全自动判定**（无人工审批）：本地 agent 决定 `is_alpha` / `alpha_type` / `confidence` / `entities`。任务后端为空或缺失时依次继承 `llm.default_backend`、`llm.provider`、Codex，并跳过 `llm.disabled_backends` 中的后端；选择 Codex 时使用只读且不依赖 daemon 当前目录的调用。每轮默认最多分类 8 条候选，成功判定为非 alpha 后静默 6 小时。JSON 解析失败按 15、30、60 分钟退避并继续重试。X 采集的登录、挑战、采集失败和本地 agent 后端全部耗尽会记录为 heartbeat 错误，不再伪装成健康的无告警；Telegram 投递失败会在告警审计写入后记录日志。

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
```

`verify-tg` 会各跑一遍当前启用的告警规则和晨报板块；超时工具与 daemon 共用。未设置 `verify.step_timeout_ms` 时按规则默认预算（名人推更长）。摘要与 PANews 分类走配置的本地 agent 链，默认优先 Codex，并跳过 `llm.disabled_backends` 中的后端。

`verify-celebrity --dry-run` 只检查 X 搜索页状态，不调 LLM、不推 Telegram；`unknown` 表示搜索页已加载但没有识别到推文或无结果标记，会作为 warning 展示，登录、挑战和真正错误仍会让健康检查失败。

市场晨报会并发请求 OKX 现货/合约接口，并使用较短的单请求预算。网络环境特殊时可用 `data_sources.market.request_timeout_ms` 和 `data_sources.market.fallback_timeout_ms` 调整新鲜度与晨报耗时之间的取舍。

市场、股票和美债行情在上游接口提供时会显示源行情时间。Yahoo 股票/美债行情遇到瞬时失败会重试一次；美债标的缺失时会显示降级提示，降息预期结论按配置的波动阈值生成，不再固定套用方向。

Twitter 采集器会对已登录的 `x.com/home` 虚拟时间线执行多轮下拉采样，并在 X 卸载旧 DOM 节点前跨轮合并推文。可用 `data_sources.twitter.collect_limit`、`scroll_rounds`、`scroll_wait_ms` 和 `stagnant_rounds` 调整覆盖量与采集耗时。采集日志会分别记录轮数、DOM 扫描量、唯一量、重复量、新增缓存、近 24 小时数量与作者数。这仍然是当前登录账号可见的主页流，不是 X 全量归档。

Twitter 晨报默认相关性过滤；板块标题显示「缓存→筛后→已分析」漏斗。LLM 模式会把筛选后的全部推文纳入摘要输入，数量仅受 `data_sources.twitter.max_display`（默认 `500`）这一总量保险限制；推文按可用的点赞、转发、回复和浏览量排序，同分时优先较新推文。摘要最多输出 5 条，并保留作者、UTC+8 时间和原始链接的来源索引。需要原始时间线时设 `data_sources.twitter.relevance_filter` 为 `false`。Telegram meme 摘要优先保留有价格依据的买卖、流动性、市值和集中度，并压缩、限制普通转账与空投列表；Chain.fm 原文引用的代币合约和缩写钱包会在确定性的地址索引中输出完整地址。干跑预览不会覆盖最近一次定时或手动投递晨报的持久化元数据。

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
