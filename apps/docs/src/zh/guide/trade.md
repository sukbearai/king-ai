# 交易信号（Trade）

`king-ai trade` 在单一 supervisor daemon 中运行告警规则、晨报、Twitter 采集和看门狗。栈为 **OpenCLI + tg + 本地 agent + Yahoo**，七条规则：`b`、`e`、`f`、`t`、`tm`、`discord_wba`、`q`。

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

## 配置

主配置文件：`~/.king-ai/trade_config.json`（可用 `KING_AI_TRADE_CONFIG` 覆盖）。

常用路径：

```text
~/.king-ai/trade_config.json
~/.king-ai/trade/logs/daemon.log
~/.king-ai/trade/scratchpad.json
~/.king-ai/trade/rule_state.json
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
| `alerts.enabled` | 启用的规则 ID；默认 `b`、`e`、`f`、`t`、`tm`、`discord_wba`、`q` |
| `alerts.poll_seconds` | 统一规则轮询间隔（默认 `120`） |
| `alerts.confluence_enabled` | 单规则 tick 内同标的共振升 severity（默认 `true`） |
| `alerts.rule_stagger_ms` | 一轮轮询中规则之间的间隔毫秒（默认 `1000`） |
| `briefing.enabled` | 晨报板块，例如 `market`、`stocks`、`telegram`、`twitter`、`leaderboard`、`pumpfun` |
| `briefing.schedule_hour` | 晨报 cron 小时（本地时间，默认 `5`） |
| `verify.step_timeout_ms` | `verify-tg` 每个告警规则和晨报板块的单源超时时间（默认 `60000`） |
| `data_sources.pumpfun` | Pump.fun 板块：`stage`（默认 `MIGRATED`）、`limit`、市值/持有人/成交量/Top10 过滤；可读摘要 + LLM 归纳 |
| `data_sources.leaderboard` | 聪明钱榜单：`chains`、`limit`、`time_frame`、`sort_by`；可读摘要 + LLM 归纳 |
| `treasury` | 美债抛售 / 收益率：`^TYX`（30Y）、`^TNX`（10Y）、`TLT` 价格；阶段新高与 bp 飙升告警 |
| `llm.agent_tasks.<task>.timeout_ms` | 可选的本地 agent 单任务超时，例如 `celebrity_extract` |
| `telegram` | `bot_token` 与 `push_chat_id`，用于推送告警 |

仓库内模板见 `packages/cli/trade_config.example.json`。

## 告警规则

列出已注册规则：

```sh
king-ai trade alert list
```

单次运行某条规则：

```sh
king-ai trade alert run q --once
king-ai trade alert run tm --once --push-tg
```

| ID | 监控内容 |
|----|----------|
| `b` | 美债抛售 / 收益率（`^TYX` 30Y、`TLT` 价格，Yahoo） |
| `e` | Meme 大单（`tg` meme链上监控） |
| `f` | 自选股涨跌（OpenCLI/Yahoo） |
| `t` | 名人推文 alpha（默认 Trump/Musk/CZ） |
| `tm` | Twitter ticker 提及加速 |
| `q` | PANews 事件（本地 agent 分类） |
| `discord_wba` | Discord WBA 频道（OpenCLI browser） |

`info` 级告警写入 JSONL；Telegram 默认只推 `warning` 及以上。告警 cooldown 持久化在 `~/.king-ai/trade/rule_state.json`。

## Daemon Supervisor

daemon 使用统一规则调度器，并运行定时任务：

- 晨报（`briefing.schedule_hour`）
- regime 检测
- Twitter 采集与看门狗

晨报 Telegram 投递会在 `~/.king-ai/trade/logs/daemon.log` 写入
`[morning-brief] telegram push ok|failed chunks=N`，最近一次投递元数据也会写到
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
king-ai trade watchdog --kill
```

`verify-tg` 会各跑一遍当前启用的告警规则和当前配置的晨报板块，每个源推一条 Telegram。每个源都会受 `verify.step_timeout_ms` 独立保护，一个慢采集器或 LLM 摘要只会被报告为该源失败，不会拖住整体验证。晨报摘要与 PANews 分类走本地 agent CLI 链（`grok` → `claude` → `codex`），由 `llm.default_backend` 控制首选后端。如果所有本地 agent 后端都不可用，晨报摘要会降级为压缩后的本地文本，而不是直接发送完整原始 feed。

Twitter 晨报默认开启相关性过滤，只保留市场、宏观、加密、AI/芯片、上市公司和监管相关内容，并过滤体育、信用卡、账号池、VPN、促销等低价值噪声。需要检查原始时间线时，可将 `data_sources.twitter.relevance_filter` 设为 `false`。

## OpenCLI Browser Bridge

Twitter 时间线、雪球 A 股、Discord 浏览器抓取通过 **OpenCLI** 复用已登录的浏览器会话，不需要用 remote debugging port 启动 Chrome。

```sh
opencli doctor
opencli browser trade-twitter --window background open https://x.com/home
opencli browser trade-twitter --window background wait selector article --timeout 30000
king-ai trade alert run f --once --dry-run
```

保持 OpenCLI 浏览器扩展/daemon 可用，并在对应站点完成登录。daemon 使用稳定的 `trade-twitter`、`trade-twitter-search`、`trade-discord` 会话。雪球优先走 OpenCLI background/persistent，适配器不可用时快速回退 Yahoo Finance。

## 外部依赖

- `opencli` — Twitter/X、雪球、Discord 浏览器读取
- `tg` — Telegram 频道读取
- `onchainos` — 可选的聪明钱 Leaderboard 与 Pump.fun 晨报板块
- Yahoo Finance HTTP — 股票报价
- 本地 agent CLI（`grok`、`claude`、`codex`）— 摘要、PANews 分类、名人推文解析

PANews 文章拉取使用 `~/.king-ai/trade/skills/panews/cli.mjs`。

## 开发

```sh
pnpm dev -- trade status
pnpm dev -- trade daemon --push-tg
pnpm dev -- trade verify-tg --dry-run
```
