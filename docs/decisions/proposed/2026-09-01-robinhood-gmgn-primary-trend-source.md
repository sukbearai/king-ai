# Decision: Robinhood 趋势发现使用 GMGN 主源与 RPC 限界验证

Status: proposed

## Problem

Revision 7/8 的 RPC realtime/backfill 双车道能够保持游标与事务原子性，但目标 sidecar 已证明一次成功的 Phase 0、Phase 1、backfill 和 Phase 2 周期会持续到链尖增长超过下一轮的有界容量。继续优化单项 RPC 请求不能消除全链发现、历史回填和当前趋势共用调度预算的结构性耦合。

Robinhood 监控的产品目标是尽早观察 token 趋势，不是证明从历史 cursor 到链尖的全链扫描完整性。系统需要把发现权、验证权、候选资格和 readiness 证据来源分开，并保持所有钱包、签名、swap、订单和交易能力关闭。

## Proposal

GMGN 成为 Robinhood Chain 的主要只读趋势发现源。仓库内 HTTP adapter 使用现有 `fetch` 并固定连接 `https://openapi.gmgn.ai`，只读取 `GMGN_API_KEY`，调用 Robinhood `1m`、`5m`、`1h` trending 和 trenches 的 `new_creation`、`near_completion`、`completed` 数据。生产路径不允许覆盖 GMGN base URL，不依赖全局 `gmgn-cli`，不读取或传递 `GMGN_PRIVATE_KEY`，也不接入任何 write-capable GMGN route。

GMGN HTTPS `Date` 是认证时间偏移的网络 authority。offset 只存在内存中，按有界周期刷新，不修改 OS clock。缺少、无效或超界的 server date、认证失败、限流耗尽、schema drift 和 stale response 都 fail closed。

GMGN observation 使用精确 EVM token address、feed/interval/category、上游观测时间、摄取时间和 deterministic observation window 作为身份，并写入独立的 `robinhood_chain_gmgn.sqlite`。重复 poll 幂等更新，同一 token 的多 feed 记录保留独立 provenance 后合并。缺少市场或风险字段保持 unknown，不转成零。Phase 2 使用新增的 source-agnostic subject 字段作为 GMGN token identity，旧 pool-oriented 字段只承担已声明的兼容用途。

候选必须由 fresh `5m` trending 与同窗 `1m` 或 trenches 交叉确认，并通过已声明的 volume、liquidity、swap、holder、honeypot 和 wash-trading 门禁。Phase 2 使用 `phase2-v13-gmgn-primary` 独立 epoch；旧 v12、RPC backfill 和 X-only 数据不能计入 readiness。X 只按精确地址补充证据。

Robinhood RPC 不再负责全链发现或历史清零，只对当前 GMGN shortlist 做最多 20 个地址的 Chain ID、bytecode 和 pool/contract identity 验证。RPC 不能创建或补齐 GMGN 候选，验证失败的候选不能进入 Phase 2 materialization。

旧 RPC SQLite、cursor、coverage、audit 和 backup 全部保留为 legacy/audit，GMGN mode 不再把历史 backlog 归零作为 launch gate，也不删除或重解释旧数据。

## Alternatives considered

- 继续为 Phase 1 timestamp 做 JSON-RPC batch：目标 endpoint 已证明支持小 batch，但该优化仍保留全链扫描、backfill 和 realtime 的共同调度耦合，不能直接证明现场收敛。
- 提高 block capacity 或增加 writer/process：会扩大 provider、SQLite 和生命周期风险，并继续让早期趋势发现依赖历史追赶。
- 直接运行全局 `gmgn-cli`：当前 CLI 使用本地时间生成认证 timestamp，且本机存在约 105 秒偏差；全局包还可随外部安装变化。仓库自有 adapter 更容易固定只读 endpoint、secret boundary、schema validation 和测试。
- 完全移除 RPC：未选择，因为 Chain ID、bytecode 和 pool identity 的小规模链上复核仍能阻止第三方数据错误直接升级为 shadow candidate。

## Risks

- GMGN 是外部中心化数据源，字段和 envelope 可能变化；通过严格 parser、source health、freshness、recorded fixture 和 schema-drift fail-closed 控制。
- API key 与同目录 private key 可能被环境误传；生产 adapter 只读取一个命名变量，不启动继承 ambient environment 的子进程，并以 secret/capability tests 验证。
- GMGN rank/trenches 是 token-centric，而旧 Phase 1/2 是 pool-centric；Revision 9 必须使用 source-agnostic token subject DTO 和独立 GMGN observation persistence，不能把 token address 静默伪装成 pool identity。
- GMGN outage 会停止新趋势发现；RPC 只能验证既有候选，不能作为隐藏 fallback 制造新数据。
- 本决策改变 readiness authority，因此必须开启 v13 epoch；任何旧运行时长或 review 都不能迁入。

## Verification

- Source/unit: 本地实现已完成。GMGN/Phase 2 subset 通过 35/35，覆盖 auth clock skew、严格 nested envelope、trenches per-category client cap、address/numeric validation、unknown handling、dedup/provenance merge、candidate gate、secret redaction、严格 Chain ID、RPC non-creation、RPC abort、v13-only materialization 和 unverified rejection。
- Integration/lifecycle: Robinhood Phase 0、Phase 1、GMGN、Phase 2 和 shadow-daemon compiled suite 通过 105/105，覆盖 GMGN mode 跳过 full-chain discovery、single-flight、bounded parallel requests、timestamp replay、刷新后的 429 request budget、shutdown abort/drain、partial tick atomicity 和 ordinary trade daemon isolation。
- Test sensitivity: repository-owned manual mutation runner kill 8/8 mutants，并在恢复源码后重跑 focused suite 成功。它只证明这八个缺陷被当前测试捕获，不替代完整 mutation coverage。
- Repository: `pnpm lint` 检查 262 个文件；`pnpm verify` 通过 CLI 643/643、GUI worker 177/177、skill Node 11/11、skill Python 9/9 和 12 个 skill validation；双语 VitePress docs build、decision validator、secret/capability scan 和 `git diff --check` 均通过。生产源码没有 `GMGN_PRIVATE_KEY` 或 `X-Signature`，也没有 wallet、signature、signing、swap、order 或 trading 写能力。
- Deployed/field: 尚未执行。没有运行本实现的 live GMGN tick，没有重启 sidecar，没有修改现场 DB。仍需单独批准 isolated shadow build/restart，并证明至少三次连续 fresh GMGN ticks、六类 feed freshness、bounded RPC verification、v13-only accounting、无 secret 泄露或重复 observation/candidate/draft。72 小时、800 runs、review 和 live-delivery approval gate 均未完成，因此状态继续为 `proposed`。

## Rollback

关闭 GMGN mode 并恢复旧 RPC collector 代码。旧 RPC 数据库和 cursor 从未删除或改写，因此可继续原有语义。GMGN observation、candidate 和 v13 readiness 数据保留只读审计，不与回滚后的 RPC epoch 合并。无需 down-migration；任何后续重新启用都必须使用新的 `field_run_revision`。
