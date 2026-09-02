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
~/.king-ai/trade/state/robinhood_chain.sqlite
~/.king-ai/trade/state/robinhood_chain_phase1.sqlite
~/.king-ai/trade/state/robinhood_chain_gmgn.sqlite
~/.king-ai/trade/state/robinhood_chain_phase2.sqlite
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
| `alerts.llm_advice` | 为所有最终推送的 warning/critical Telegram 告警追加口语化「投资备忘」式 LLM 建议（默认 `false`） |
| `alerts.confluence.enabled` | 多规则对同一**非空** asset 共振时将 info 升为 warning（默认 `true`）。旧键：`alerts.confluence_enabled` |
| `alerts.confluence.window_seconds` | 共振窗口秒数（默认 `900`）。旧键：`alerts.confluence_window_seconds` |
| `alerts.rule_stagger_ms` | 一轮中规则间隔毫秒（默认 `1000`） |
| `watchdog.interval_seconds` | 服务、负载、磁盘和进程看门狗间隔（默认 `300`） |
| `watchdog.disk.path` | 要监控其所在文件系统的已有路径（默认 King AI 配置目录） |
| `watchdog.disk.warning_free_percent` | 可用空间降到该百分比时 warning（默认 `15`） |
| `watchdog.disk.critical_free_percent` | 可用空间降到该百分比时升级为 critical（默认 `8`） |
| `watchdog.disk.recovery_free_percent` | 可用空间恢复到该百分比时发送恢复通知（默认 `20`） |
| `briefing.enabled` | 晨报板块 |
| `briefing.schedule_hour` | 晨报 cron 小时（本地，默认 `5`） |
| `verify.step_timeout_ms` | `verify-tg` 单源超时（设置后覆盖规则默认） |
| `data_sources.pumpfun` / `leaderboard` | 链上晨报板块 |
| `data_sources.robinhood_chain` | 可选的只读 Robinhood Chain Phase 0 采集器与保留配置 |
| `data_sources.robinhood_chain.phase1.discovery_source` | 显式趋势源：默认的全链 `rpc`，或只读 `gmgn` |
| `data_sources.robinhood_chain.phase1.phase2` | 可选的本地 shadow 草稿与 72 小时 readiness 台账 |
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

`alerts.llm_advice=true` 时，每种规则最终通过 Telegram 严重度门槛和日 cap 的 warning/critical 告警，都会按本次发送批次调用一次 `llm.agent_tasks.alert_advice`。消息会附加一段口语化的「投资备忘」：先概括事件含义，再给原则性倾向与留意点，而不是保守/中性/激进三档清单。源站健康故障不会调用建议，因为旧数据或缺失数据不能产生投资动作。

代码拒绝保证收益、确定性涨跌、满仓/梭哈和具体证券的立即买卖指令；模型不可用、执行异常或输出不合规时改用确定性本地短文，事实告警本身不会丢失。这些内容不知道用户持仓与承受能力，不构成个性化投资建议。

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
- Twitter 采集、可选的 Robinhood Chain 采集，以及服务、负载、磁盘和进程看门狗

看门狗每隔 `watchdog.interval_seconds` 运行一次（默认 300 秒）。磁盘检查默认监控 King AI 配置目录
所在的文件系统；如需监控其他挂载盘或已挂载磁盘镜像，可把 `watchdog.disk.path` 设为该文件系统上的
已有路径。只有在状态变化时才会发送 warning、critical 或恢复消息，且 daemon 必须以 Telegram 推送模式
安装或启动。

### Robinhood Chain Phase 0

Robinhood Chain 采集器默认关闭。将 `data_sources.robinhood_chain.enabled=true` 后，daemon 才会通过只读
JSON-RPC 采集已确认的链上活动。默认每 30 秒采样一次，校验 Chain ID `4663`，维护有界的已确认区块
cursor，并重放最近一段区块用于重组检测；区块、交易、唯一发送者、合约创建和 Gas 的 5 分钟聚合保存在
`~/.king-ai/trade/state/robinhood_chain.sqlite`。

默认每轮最多处理 1,000 个区块，通过单个在途 JSON-RPC batch 依次读取，每个 HTTP batch 最多包含 50 个
完整区块请求。响应会先按 JSON-RPC id 匹配，再校验区块顺序和父哈希连续性。原始交易 input、收款方历史、钱包密钥、签名、
订单、Telegram 告警、LLM 建议和交易动作均不属于 Phase 0。默认保留 14 天数据。RPC URL 写入日志或
source-health 前会脱敏；部分批次失败时不会推进持久化 cursor。

Phase 0 将实时新鲜度与历史完整性分别记录。升级后，旧 `last_confirmed_block` 继续作为可回滚的历史回填
cursor，新 realtime cursor 从 confirmed tip 附近开始。每个采集 tick 都优先处理 realtime；历史车道再按
`backfill_collect_seconds`（默认 300 秒）向 realtime 覆盖起点前一个区块这一固定边界推进，因此链尖继续增长
不会扩大历史缺口。只有连续 gap 归零后 `history_complete` 才为 true。两个车道共用一个 SQLite writer，数据
与对应 cursor 在同一事务提交；backfill 失败会独立记录，不会把已经成功提交的 realtime 数据标成不健康。

长驻 trade daemon 或 shadow daemon 中，每个 collector 只有进程内第一次尝试可以把 realtime 覆盖移动到
confirmed tip 窗口，该权限即使首次尝试失败也会被消耗。后续同进程容量越界会在任何 cursor 或历史状态变更前
把 realtime health 标为失败，从而显式暴露新鲜度不足，而不是静默扩大历史缺口。新进程重新获得一次恢复机会；
手动单次采集默认仍允许恢复 rebase。

可在 daemon 关闭采集时手动执行一次只读采集：

```sh
king-ai trade collect-robinhood
```

命令输出 JSON，包含脱敏 endpoint、最新区块、确认目标区块、持久化 cursor、lag、采集区块数和重放替换数。
完整配置字段和边界见 `packages/cli/trade_config.example.json`。

### Robinhood Chain Phase 1 shadow 趋势

Phase 1 是 `data_sources.robinhood_chain.phase1` 下的第二层可选能力。daemon 调度要求父采集器和
`phase1.enabled` 同时为 true。Phase 1 固定使用 `delivery=shadow`：通过有界只读 RPC logs 发现已验证
协议的建池与 swap 事件，计算 5 分钟稳定币计价成交额、交易者、流动性、跨场所广度和数据质量分量，
并把确定性的 qualified/rejected 候选写入
`~/.king-ai/trade/state/robinhood_chain_phase1.sqlite`。

当前内置启用注册表包括已在 Chain ID 4663 检查字节码的 Uniswap V2/V3/V4、UP V3 和 Metric V1。
其他已调研场所会保持 disabled，直到部署地址和解码器得到验证。USD 计价目前识别链上 USDG 和 USDe
交易腿；缺少支持价格或流动性观测的池仍会被记录，但通过质量原因 fail closed。V4 池通过近期
Initialize 事件发现，在具备安全的池级流动性解码前保持 liquidity unknown。

首次启用运行时，Phase 1 会为非 V4 注册表执行一次稳定币池建池事件历史引导。它仅查询建池事件中
token 位置匹配 USDG 或 USDe 的日志，历史范围由 `stable_pool_discovery_backfill_blocks` 控制（默认
1,000,000 个区块），成功后写入持久完成标记。这样可以补回正常 cursor 之前创建的相关池，又不会让
每轮都执行大范围回溯。swap 处理仍严格限制在常规 `max_log_blocks_per_tick` 范围内（默认值和最大值均为
1,000 个区块）；历史引导失败时不会写入完成标记，后续运行会继续重试。

稳态下默认每 60 秒最多处理 1,000 个区块，日志请求按每次 500 个区块分片，并保持三个并发日志 worker。
当 confirmed target 比持久 cursor 超前超过 `catch_up_lag_blocks`（默认 10,000）时，同一采集器临时使用
独立有界的 `catch_up_blocks_per_tick`（默认值和最大值均为 2,000）。追赶模式不会改变单次请求大小、并发、
重试、稳定币池过滤或 cursor 原子提交规则。当前区间的建池扫描会把全部已启用协议地址和建池 topic 合并为
每个区块分片一个有界 OR filter，再按返回日志的地址/topic 对映射回已验证解码器；这样保留完整协议覆盖，
同时避免对同一区间按协议重复查询。非 V4 稳定币池 swap 扫描也会把最多 50 个执行地址及其协议 swap topic
合并到一个有界 filter，并要求每条返回日志的地址/topic 都能映射回请求中的池与解码器。V4 每个有界区块分片
只按 swap topic 查询一次已验证 PoolManager；返回日志仍必须匹配该 PoolManager 与 topic。已知非稳定币 pool key
和格式合法但本地未知的 pool key 会被过滤，已知稳定币池会被解码；畸形 pool key 或已登记但身份冲突的池会使
批次失败且不推进状态。这样既降低请求突发，也不会引入非稳定币池或未知日志。

Phase 1 使用相同的 realtime/backfill 双车道。旧 `last_confirmed_block` 保留为安全回滚所需的历史进度；
realtime 仍受 `max_log_blocks_per_tick` 约束，历史批次按 `backfill_collect_seconds`（默认 300 秒）使用已有稳态或
catch-up budget。两个车道在同一个 collector 内顺序运行，并保持单一 SQLite writer。审计行记录
`collection_lane`，Phase 2 只统计和物化 realtime 审计，因此即使迟到历史窗口仍落在 24 小时 lookback 内，
也不能变成当前 shadow 告警。现场加载这一新采集语义时必须提升 `phase2.field_run_revision`，旧 epoch 的时长
不能证明新的 realtime 路径。

可通过 `phase1.rpc_urls` 把日志采集器与父级 Phase 0 端点列表隔离；
未配置或为空时继续继承 `data_sources.robinhood_chain.rpc_urls`，因此旧配置与回滚行为保持不变。当两个阶段同时到期且清洗后的 RPC endpoint
集合完全不重叠时，sidecar 会并行运行 Phase 0 和 Phase 1，等待两者均结束后再启动 Phase 2。每个阶段仍为
single-flight，任一阶段失败不会取消另一阶段。如果存在任何重叠，包括继承端点或同一 URL 的凭据/query 变体，
则继续使用 Phase 0 -> `provider_cooldown_ms`
（默认 5,000，范围 0-30,000）-> Phase 1 串行路径。停机可中断尚未结束的 cooldown，不会启动后续 Phase 2 或 X 工作，并在释放 PID lock 前
排空已经启动的链上采集任务。遇到限流或拒绝访问时会进行有界重试和端点轮换；全部端点耗尽时保持 source
unhealthy，且不会推进 cursor。Phase 1 不发送 Telegram、不调用 LLM、不访问钱包、也不交易。可手动运行一次隔离的
shadow tick：

```sh
king-ai trade collect-robinhood-phase1
```

手动命令始终只读，只输出有界 shadow 摘要。至少完成 72 小时 shadow 证据后，Telegram 仍需单独批准。

显式 X 注册表在 Phase 1 启用时默认开启；如需关闭请设置 `phase1.x_enabled=false`。shadow sidecar 按
`x_collect_seconds`（默认 300 秒）调度它。它会直接搜索配置的 Tier A/B/C 账号，而不是假设主页时间线一定
覆盖这些账号；系统只保存有界的推文证据和账号健康状态（`ok`、`no_results`、`auth_required`、`challenge`、
`unknown` 或 `error`），X 内容本身不能创建链上趋势信号。可用 `king-ai trade collect-robinhood-x` 手动执行
一次账号采集。默认注册表会优先监控用户提供的 Robinhood 管理层/产品与早期 Alpha 名单：`vladtenev`、
`BaijuBhatt`、`JohannKerbrat`、`fern`、`abhishekf96`、`GrantBradford`、`23XIRacing`、`yeon_`、
`kenjidgn`、`PhilOnChai`、`Wolves_Techml`、`GuarEmperor`、`KookCapitalLLC`、`Cyril_Cryptt`、
`cypherpunkgod`、`theunipcs`、`CryptoKaleo`、`blknoiz06`、`Mrbankstips`、`eliz883`、`Arnold__AI` 和
`FloorWatchRH`，随后再采集原有官方与基础设施账号。当前采集器读取账号发帖搜索结果，不宣称覆盖关注或
点赞动作。

显式设置 `phase1.discovery_source="gmgn"` 可启用以 GMGN 为主源的 token 趋势路径。该模式只要求
`GMGN_API_KEY`；运行时不读取 `GMGN_PRIVATE_KEY`，不签名钱包载荷，也不具备 swap、订单或投递能力。每个到期
tick 读取 Robinhood 的 `1m`、`5m`、`1h` 排名，以及 trenches 的 `new_creation`、`near_completion`、
`completed` 三类数据，在客户端对每个分类分别执行硬上限，并把归一化观测写入独立数据库
`~/.king-ai/trade/state/robinhood_chain_gmgn.sqlite`。API origin 固定为 `https://openapi.gmgn.ai`；认证
timestamp 根据有界的 HTTPS `Date` 响应校正，不修改操作系统时钟。

候选必须由 fresh 且安全的 `5m` 记录与同窗 `1m` 或 trenches 记录交叉确认，再对最多 20 个唯一地址执行
Chain ID 和 bytecode 限界验证。GMGN 模式下 daemon 跳过全链 Phase 0 和 RPC Phase 1 发现，保留其数据库与
历史 cursor 不动，然后仅使用已验证的 GMGN 候选运行 Phase 2。Phase 2 自动隔离到
`phase2-v13-gmgn-primary`，旧 RPC epoch 不能计入 readiness；X 仍只能按精确地址补充证据。
`gmgn_limit`（默认 100，最大 200）、`gmgn_max_age_seconds`（最大 600）和 `gmgn_rpc_verify_limit`（最大 20）
都是 fail-closed 边界。可手动执行一次已配置的 GMGN tick：

```sh
king-ai trade collect-robinhood-gmgn
```

该命令始终为 shadow-only，不会启用交易或 Telegram 投递。把 `discovery_source` 改回 `rpc` 即可恢复使用未被
改写的旧扫描器数据库；v13 readiness 不会并入 RPC epoch。

### Robinhood Chain Phase 2 shadow readiness

Phase 2 是 `phase1.phase2` 下额外启用的本地证据层。它只读取候选和审计记录，在独立数据库中
物化确定性的 shadow 告警草稿，并衡量 72 小时实地门禁；它不会重新扫描链或修改 Phase 1 分数。只有当
X 帖子正文包含完整池地址或代币地址时，才会附加为补充证据，而且 X 不能创建草稿。

默认 readiness 要求至少覆盖 72 小时、成功运行 800 次、运行间隔不超过 15 分钟、源错误率不超过 5%、
至少一个 Phase 1 审计窗口，以及十条经过人工明确复核的 shadow 草稿。全部通过时只返回
`approval_required`，不会授权或开启 Telegram 投递。

readiness 按 `phase2.field_run_revision` 隔离。旧 revision 的运行、草稿和复核记录仍保留在 SQLite 中供
审计，但不会计入当前 72 小时门禁。每当采集器、解码器、阈值或现场配置发生实质变更并加载后，都必须
提升该 revision，避免把变更前的运行时间误算成最终实现的连续证据。

可执行一次物化、查看本地台账并记录人工结论：

```sh
king-ai trade collect-robinhood-phase2
king-ai trade robinhood-phase2-status --limit 20
king-ai trade review-robinhood-phase2 <alert-id> accepted --note "复核说明"
```

如需隔离开展现场运行，应准备一个仅包含 Robinhood Chain 设置的独立 `KING_AI_CONFIG_DIR`，并启动
`king-ai trade robinhood-shadow-daemon`。仅当清洗后的 RPC endpoint 集合完全不重叠时，该 sidecar 才并行运行到期的 Phase 0 与 Phase 1；
否则继续使用串行 provider cooldown 路径，Phase 2 始终等待两个链上阶段结束。Phase 1 X 注册表作为独立的
single-flight 任务调度，账号扫描不会延迟链上周期。它使用独立 PID 锁与
SQLite 文件，不包含 Telegram、LLM、钱包、签名、下单或晨报路径。调度器默认每 30 秒唤醒，同时保留
配置中的 30/60/300 秒周期；停止时会等待已在运行的链上与 X 采集结束，再释放 PID 锁。

```sh
KING_AI_CONFIG_DIR=~/.king-ai-robinhood-shadow king-ai trade robinhood-shadow-daemon
```

人工结论只能是 `accepted` 或 `rejected`。Phase 2 固定为 `delivery=shadow`，不调用 LLM、不访问钱包、
不签名、不下单、不交易。完成 readiness 证据和误报样本复核后，live delivery 仍需单独批准。

晨报 Telegram 投递会在 `~/.king-ai/trade/logs/daemon.log` 写入
`[morning-brief] telegram push ok|failed chunks=N`，最近一次投递元数据在
`~/.king-ai/trade/scratchpad.json` 的 `last_brief_push`。

Telegram 频道读取会串行执行，因为 `tg` 命令共用同一个 Telethon session。子进程失败只会生成有长度
上限的诊断摘要，不会把依赖日志原样写入晨报。单次消息最多发送 10 个 Telegram 分片，首个分片失败后
立即停止，避免依赖日志演变成连续刷屏。

```sh
king-ai trade daemon --push-tg
king-ai trade restart-service
king-ai trade logs
```

## 辅助命令

```sh
king-ai trade brief --push-tg
king-ai trade collect
king-ai trade collect-robinhood
king-ai trade collect-robinhood-phase1
king-ai trade collect-robinhood-x
king-ai trade collect-robinhood-phase2
king-ai trade robinhood-shadow-daemon
king-ai trade robinhood-phase2-status --limit 20
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

Twitter 晨报默认相关性过滤；板块标题显示「缓存→筛后→已分析」漏斗。筛选优先认 `$TICKER` 与已知交易标的，并拦截游戏联动、广告、账号登录等噪声；排序先看市场相关度，再看互动。LLM 模式的排序候选同时受 `data_sources.twitter.llm_max_display`（默认 `150`）、总量上限 `max_display` 和 `per_author_cap` 限制；非 LLM 展示仍使用 `max_display`。摘要最多输出 5 条交易相关判断，并保留作者、UTC+8 时间和原始链接的来源索引；摘要后会追加相关推文速览，`data_sources.twitter.quick_list_size` 默认为 `10`，设为 `0` 可关闭。需要原始时间线时设 `data_sources.twitter.relevance_filter` 为 `false`。Telegram 非 meme 频道摘要按影响写「发生了什么 + 为何要紧」；meme 摘要优先保留有价格依据的买卖、流动性、市值和集中度，并压缩普通转账与空投；Chain.fm 原文引用的代币合约和缩写钱包会在地址索引中输出完整地址。启用 LLM 摘要时，`briefing.daily_summary` 默认为 `true`；至少两个板块成功后，会结合 scratchpad 市场状态输出口语化「投资备忘」与风险倾向，而不是涨跌幅清单。晨报板块仍并行拉取，但 Telegram 各频道会串行读取，因为所有 `tg` 调用共用一个 Telethon session。股票板块默认只展开异动（个股 |Δ|≥5%、指数/ETF |Δ|≥3%），其余折叠；`briefing.stocks_show_all=true` 可恢复全量自选。meme 摘要会把侮辱性钱包昵称替换为中性「地址」。干跑预览不会覆盖最近一次定时或手动投递晨报的持久化元数据。

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
