# 交易信号（Trade）

`king-ai trade` 替代旧版 `trade-agent`：告警规则、晨报、Twitter 采集、准确率追踪、周报和看门狗统一在一个 supervisor daemon 里运行。`king-ai signal` 负责多源 SignalEngine 融合扫描。

## 快速开始

复制示例配置并安装后台服务：

```sh
mkdir -p ~/.king-ai
cp path/to/trade_config.example.json ~/.king-ai/trade_config.json
# 编辑 telegram bot_token、push_chat_id、llm 密钥、自选股等

king-ai trade install-service --push-tg
king-ai trade status
```

`install-service` 会注册 `dev.king-ai-trade`（macOS LaunchAgent 或 Linux systemd 用户单元），并在存在时卸载 legacy `com.trade-agent.*`，然后启动 daemon。

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
~/.king-ai/trade/signals/signal_log.jsonl
~/.king-ai/trade/skills/panews/cli.mjs
```

告警历史（与旧版 accuracy tracker 共用）：

```text
~/.onchainos/strategies/alerts/alert_log.jsonl
```

主要配置段：

| 配置段 | 作用 |
|--------|------|
| `alerts.enabled` | 启用的规则 ID（`a`–`u`、`s`、`t`、`tm`，可选 `discord_wba`） |
| `alerts.poll_seconds` | 规则轮询间隔（默认 `120`） |
| `alerts.aggregator_seconds` | 多指标共振聚合间隔（默认 `300`） |
| `signals.scan_seconds` | daemon 内 SignalEngine 间隔；`0` 表示关闭自动扫描 |
| `briefing.schedule_hour` | 晨报 cron 小时（本地时间，默认 `5`） |
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
| `a` | BTC/ETH/SOL 价格异动 |
| `b` | 资金费率 |
| `c` | 聪明钱集群 |
| `d` | Polymarket 偏移 |
| `e` | Meme 大单 / 新币 |
| `f` | 自选股涨跌 |
| `g` | 期权异常 |
| `h` | 稳定币流动 |
| `i` | 鲸鱼转账 |
| `j` | VIX 飙升 / 高位 |
| `k` | 均线跌破 / 突破 |
| `l` | RSI 极端 |
| `m` | 布林带收窄 / 突破 |
| `n` | 清算级联 |
| `o` | Gas 飙升 |
| `p` | 宏观新闻（Bloomberg） |
| `q` | PANews 事件 |
| `r` | 多空比 |
| `s` | 订阅钱包地址 |
| `t` | 名人推文 alpha（默认 Trump/Musk/CZ） |
| `tm` | Twitter ticker 提及加速 |
| `u` | BTC ETF 流向（另每日 22:00 定时跑一次） |
| `discord_wba` | Discord WBA 频道（需 Chrome CDP，见下方） |

`info` 级告警写入 JSONL；Telegram 默认只推 `warning` 及以上。

## Daemon 监督器

daemon 会跑所有已启用规则循环，并调度：

- 晨报（`briefing.schedule_hour`）
- 规则 `u` 每天 22:00
- 周报每周日 06:00
- 告警聚合、可选 SignalEngine、regime 检测
- Twitter 采集、准确率周期、进程看门狗

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
king-ai trade unload-legacy --remove
```

## SignalEngine

手动融合扫描：

```sh
king-ai signal scan
king-ai signal scan --push-tg --threshold 0.3
king-ai signal scan --sources smart_money,technical,event
```

在配置里开启自动扫描：

```json
"signals": { "scan_seconds": 600 }
```

输出：`~/.king-ai/trade/signals/signal_log.jsonl` 与 `latest_scan.txt`。

## 辅助命令

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade accuracy --stats
king-ai trade watchdog --kill
king-ai trade weekly-review --push-tg
```

## 外部依赖

## Chrome CDP（替代 opencli）

Twitter 时间线、雪球 A 股、Discord 浏览器抓取改为通过 **Chrome DevTools Protocol** 访问你已登录的 Chrome：

```sh
# macOS：先完全退出 Chrome，再用日常 profile 加调试端口启动（非 headless）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

环境变量 `KING_AI_CHROME_CDP_URL`（默认 `http://127.0.0.1:9222`）或在 `trade_config.json` 的 `data_sources.chrome.cdp_url` 配置调试地址。trade daemon 会 **attach 到已打开的 Chrome 标签页**（优先复用 x.com / xueqiu.com / discord.com 页面），使用你已登录的日常会话。

## 外部依赖

规则在本地调用以下 CLI（若已安装）：

- `onchainos` — 链上数据
- `surf` — 行情、资金费率、期权
- `tg` — Telegram 频道读取
- Gemini API 或 `claude` / `codex` — LLM 摘要与 PANews 分类

PANews 拉新闻使用 `~/.king-ai/trade/skills/panews/cli.mjs`，缺失时需自行拷贝 PANews skill 的 `cli.mjs`。

## 开发

```sh
pnpm dev -- trade status
pnpm dev -- trade daemon --push-tg
pnpm dev -- signal scan
```