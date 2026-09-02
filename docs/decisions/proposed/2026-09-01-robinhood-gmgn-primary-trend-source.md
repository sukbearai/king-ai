# Decision: Robinhood 趋势发现使用 GMGN 主源与 RPC 限界验证

Status: proposed

## Problem

Revision 7/8 的 RPC realtime/backfill 双车道能够保持游标与事务原子性，但目标 sidecar 已证明一次成功的 Phase 0、Phase 1、backfill 和 Phase 2 周期会持续到链尖增长超过下一轮的有界容量。继续优化单项 RPC 请求不能消除全链发现、历史回填和当前趋势共用调度预算的结构性耦合。

Robinhood 监控的产品目标是尽早观察 token 趋势，不是证明从历史 cursor 到链尖的全链扫描完整性。系统需要把发现权、验证权、候选资格和 readiness 证据来源分开，并保持所有钱包、签名、swap、订单和交易能力关闭。

## Proposal

GMGN 成为 Robinhood Chain 的主要只读趋势发现源。仓库内 HTTP adapter 使用现有 `fetch` 并固定连接 `https://openapi.gmgn.ai`，只读取 `GMGN_API_KEY`，调用 Robinhood `1m`、`5m`、`1h` trending 和 trenches 的 `new_creation`、`near_completion`、`completed` 数据。生产路径不允许覆盖 GMGN base URL，不依赖全局 `gmgn-cli`，不读取或传递 `GMGN_PRIVATE_KEY`，也不接入任何 write-capable GMGN route。

GMGN HTTPS `Date` 是认证时间偏移的网络 authority。offset 只存在内存中，按有界周期刷新，不修改 OS clock。缺少、无效或超界的 server date、认证失败、限流耗尽、schema drift 和 stale response 都 fail closed。

GMGN observation 使用精确 EVM token address、feed/interval/category、上游观测时间、摄取时间和 deterministic observation window 作为身份，并写入独立的 `robinhood_chain_gmgn.sqlite`。重复 poll 幂等更新，同一 token 的多 feed 记录保留独立 provenance 后合并。缺少市场或风险字段保持 unknown，不转成零。Phase 2 使用新增的 source-agnostic subject 字段作为 GMGN token identity，旧 pool-oriented 字段只承担已声明的兼容用途。

候选必须由 fresh `5m` trending 与同窗 `1m` 或 trenches 交叉确认，并通过已声明的 volume、liquidity、swap、holder、honeypot 和 wash-trading 门禁。当同窗 fresh GMGN evidence 中只有一个严格合法的 X/Twitter 项目账号时，它以“GMGN 声明、未经独立归属验证”的语义增加 5 分；明确的布尔型社交重复标志或多个有效账号冲突会拒绝候选。缺失或畸形社交字段不构成拒绝，项目账号也不能替代任何市场、风险、交叉确认或 RPC 验证。Phase 2 使用 `phase2-v14-gmgn-project-x` 独立 epoch；旧 v13、RPC backfill 和 X-only 数据不能计入 readiness 或自动投递。X 帖子继续只按精确地址补充证据。

Robinhood RPC 不再负责全链发现或历史清零，只对当前 GMGN shortlist 做最多 20 个地址的 Chain ID、bytecode 和 pool/contract identity 验证。RPC 不能创建或补齐 GMGN 候选，验证失败的候选不能进入 Phase 2 materialization。

旧 RPC SQLite、cursor、coverage、audit 和 backup 全部保留为 legacy/audit，GMGN mode 不再把历史 backlog 归零作为 launch gate，也不删除或重解释旧数据。

## Alternatives considered

- 继续为 Phase 1 timestamp 做 JSON-RPC batch：目标 endpoint 已证明支持小 batch，但该优化仍保留全链扫描、backfill 和 realtime 的共同调度耦合，不能直接证明现场收敛。
- 提高 block capacity 或增加 writer/process：会扩大 provider、SQLite 和生命周期风险，并继续让早期趋势发现依赖历史追赶。
- 直接运行全局 `gmgn-cli`：当前 CLI 使用本地时间生成认证 timestamp，且本机存在约 105 秒偏差；全局包还可随外部安装变化。仓库自有 adapter 更容易固定只读 endpoint、secret boundary、schema validation 和测试。
- 完全移除 RPC：未选择，因为 Chain ID、bytecode 和 pool identity 的小规模链上复核仍能阻止第三方数据错误直接升级为 shadow candidate。

## Risks

- GMGN 是外部中心化数据源，字段和 envelope 可能变化；通过严格 parser、source health、freshness、recorded fixture 和 schema-drift fail-closed 控制。项目 X 字段只表示 GMGN 声明，不能被描述为已验证官方；现场当前 observation 也可能完全不返回该字段，因此它只能是软加分而非硬门槛。
- API key 与同目录 private key 可能被环境误传；生产 adapter 只读取一个命名变量，不启动继承 ambient environment 的子进程，并以 secret/capability tests 验证。
- GMGN rank/trenches 是 token-centric，而旧 Phase 1/2 是 pool-centric；Revision 9 必须使用 source-agnostic token subject DTO 和独立 GMGN observation persistence，不能把 token address 静默伪装成 pool identity。
- GMGN outage 会停止新趋势发现；RPC 只能验证既有候选，不能作为隐藏 fallback 制造新数据。
- 本决策改变 readiness authority，项目社交评分语义因此开启 v14 epoch；任何 v13 运行时长、review、draft、claim 或 cooldown authority 都不能迁入。

## Verification

- Source/unit: GMGN、Phase 2 与 Telegram subset 通过 48/48，覆盖严格 X/Twitter profile 归一化、危险 URL 拒绝、缺失/畸形字段兼容、5 分软加分、duplicate/conflict fail-closed、市场与风险门禁不可绕过、v13 到 v14 隔离、纯文本 `GMGN-declared` 展示，以及原有 auth、clock、RPC 和 delivery 行为。
- Integration/lifecycle: Robinhood Phase 0、Phase 1、GMGN、Phase 2、Telegram 和 shadow-daemon compiled suite 通过 127/127，覆盖 GMGN mode 跳过 full-chain discovery、single-flight、bounded parallel requests、timestamp replay、刷新后的 429 request budget、shutdown abort/drain、partial tick atomicity、automatic-delivery ownership 和 ordinary trade daemon isolation。
- Test sensitivity: repository-owned GMGN manual mutation runner kill 14/14 mutants，并在恢复源码后重跑 focused suite 成功。其中新增 mutant 攻击 reserved route、duplicate/conflict rejection、score bonus、v14 epoch 和错误的 `official` 标签。它不替代完整 mutation coverage。
- Repository: `pnpm lint` 检查 264 个文件；`pnpm verify` 通过 CLI 661/661、GUI worker 177/177、skill Node 11/11、skill Python 9/9 和 12 个 skill validation；双语 VitePress docs build、decision validator、secret/capability scan 和 `git diff --check` 均通过。生产源码没有 `GMGN_PRIVATE_KEY` 或 `X-Signature`，也没有 wallet/private-key/swap/order/trade route。
- Deployed/field: v14 尚未部署。没有从本实现运行 live GMGN tick，没有重启 sidecar，也没有修改现场 DB。只读现场快照显示现有 26,326 条 observation 均未包含 `social_links` 或 `is_social_duplicate`，因此项目账号保持软信号。仍需单独批准 fixed build/restart，并证明 fresh GMGN ticks、六类 feed freshness、bounded RPC verification、v14-only accounting、无 secret 泄露或重复 observation/candidate/draft，以及真实 Telegram 结果。状态继续为 `proposed`。

## Rollback

关闭 GMGN mode 并恢复旧 RPC collector 代码。旧 RPC 数据库和 cursor 从未删除或改写，因此可继续原有语义。GMGN observation、candidate 和 v13/v14 readiness 数据保留只读审计，不与回滚后的 RPC epoch 合并。无需 down-migration；任何后续重新启用都必须使用新的 `field_run_revision`。
