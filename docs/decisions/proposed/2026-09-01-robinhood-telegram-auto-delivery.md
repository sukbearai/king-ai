# Decision: Robinhood Phase 2 使用持久化自动 Telegram 投递

Status: proposed

## Problem

Robinhood GMGN 主链路已经能够稳定地产生 v13 Shadow 草稿，但当前 Phase 2 明确拒绝 `delivery="telegram"`，readiness 也始终报告 `liveDeliveryAuthorized=false`。用户要求取消逐条人工批准，让新的合格趋势自动发送到现有 Telegram 目标。

直接在 materialization 后调用 Telegram 会产生三个持久风险：现有历史草稿可能在首次启用时集中发送；同一 token 的连续窗口会重复刷屏；进程在外部发送与 SQLite 确认之间退出时无法判断 Telegram 是否已经接收。Telegram `sendMessage` 不提供可由客户端控制的幂等键，因此系统无法承诺 exactly-once。

## Proposal

保留 `shadow` 作为默认值，仅允许隔离 sidecar 显式配置 Phase 2 `delivery="telegram"`。GMGN、RPC 验证和 Phase 2 materialization 先完成并提交，sidecar 再从 Phase 2 数据库认领新的当前 epoch draft。项目 X 证据语义使用 `phase2-v14-gmgn-project-x` authority；v13 draft、claim 和 cooldown 状态保留审计但不能混入 v14 投递。手动 Phase 2 命令和普通 trade scheduler 不产生外部投递。

若候选 evidence 含一个已经严格归一化的 GMGN-declared project X handle，消息以纯文本显示 `project_x=@handle (GMGN-declared)`。它不被标注为 official，也不生成链接；缺失该信号不阻止投递，而 duplicate/conflicting social identity 已在 GMGN 候选阶段 fail closed。

Phase 2 数据库以 additive migration 增加 delivery metadata、per-alert claim 和 per-subject cooldown 状态。首次启用以当时的现有 draft 建立 baseline，历史 draft 记为 `suppressed_existing`，不补发；其 subject 同时进入默认一小时 cooldown。之后每周期最多发送十个不同且不在 cooldown 的新 subject，每个外部请求只含一条 alert，避免多 chunk 部分成功后整批重试。

已知失败进入有界 `retry_wait`，每周期每 alert 最多一次尝试，只在 draft 仍然 current 时重试。发送前状态先持久化为 `sending`；若进程重启发现该状态，则改为 terminal `unknown`，不自动重发。这是显式 at-most-once 选择：接受少量可观测的可能漏发，避免无法判定结果时重复刷屏。

72 小时、800 runs、source error、gap、audit 和人工 review 继续作为质量指标，但不再是显式 Telegram 模式的投递门禁。`liveDeliveryAuthorized` 表示当前配置是否明确授权投递，不代表收益质量或交易授权。钱包、签名、swap、order、trade 和 LLM 能力继续关闭。

## Alternatives considered

- 直接发送所有当前 draft：会把现有历史数据误作实时消息并造成首启洪峰。
- 仅靠内存 Set 去重：进程重启后丢失，不能支撑持久 sidecar。
- 发送失败一律自动重试：无法区分 Telegram 已接收但本地未确认的情况，会制造重复。
- 等待 readiness 后自动发送：与用户明确要求的立即自动投递相冲突；readiness 保留为质量观测而非授权门禁。
- 把 Phase 2 alert 转成普通 trade AlertRule：会混合两个 ledger、cooldown 和调度所有者，增加重复投递与回滚复杂度。

## Risks

- At-most-once 会在模糊失败时留下 `unknown`，可能漏掉一条消息；状态和 alert id 必须可观测，后续不得静默重试。
- 外部 Telegram 不可用时 pending 数量可能增长；每周期发送上限、当前-draft 过滤和 cooldown 限制资源与消息速率。
- Additive schema 会被旧二进制忽略，但新 delivery rows 无法由旧版本消费；回滚必须先停止 sidecar，再恢复 `delivery="shadow"`，然后启动旧二进制。
- 读取正式 trade 配置中的 Telegram 凭据扩大了 isolated sidecar 的外部能力；现场 wrapper 只提取 bot token 和 push chat id，不复制值到 shadow JSON、plist、日志或仓库。

## Verification

- Source/unit: focused SQLite、Telegram boundary、project-X rendering 和 shadow-daemon tests 已覆盖首次基线、cooldown、readiness 解耦、退避、模糊发送、重启恢复、停机中断、十条上限、oversized、缺失凭据、v13/v14 隔离和 `GMGN-declared` 纯文本标签。Telegram mutation runner kill 5/5，GMGN/project-X mutation runner kill 14/14，并都恢复原始源码后重跑 clean focused suite。
- Repository: 本地 lint 检查 264 个文件；workspace verify 通过 CLI 661/661、GUI worker 177/177、skill Node 11/11、skill Python 9/9 和 12 个 skill validation；双语 docs build、decision validator、secret/capability scan 和 diff check 通过。确切命令和边界记录在 `docs/robinhood-chain-x-rpc-reliability-evidence.md`。
- Deployed/field: v14 待独立备份、fixed build、shadow-to-Telegram 配置确认、sidecar 重启和真实 delivery ledger/Telegram 结果验证。正式 trade daemon 不在 rollout 范围。

## Rollback

先将隔离配置恢复为 `delivery="shadow"`，优雅停止并重启 `dev.king-ai-robinhood-shadow`。Additive delivery tables 保留审计，不需要 down-migration；shadow 模式不会读取或发送其中的 pending/retry rows。恢复旧二进制前必须确认 sidecar 已停止，避免新旧 owner 同时写 Phase 2 SQLite。Telegram 和 GMGN 凭据值不写入数据库，因此回滚不涉及 secret migration。
