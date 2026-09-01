# Decision: Robinhood 实时采集与历史回填使用独立车道

Status: proposed

Revision 9 proposes superseding this field-nonconvergent design with
[`2026-09-01-robinhood-gmgn-primary-trend-source.md`](./2026-09-01-robinhood-gmgn-primary-trend-source.md).
This record remains proposed until that exact revision is approved; its implemented legacy data and rollback facts remain valid.

## Problem

Phase 0 和 Phase 1 当前都以单一 `last_confirmed_block` 从历史位置向链尖推进。Revision 6 已让两个阶段在 RPC 所有权隔离时并行并证明短窗 lag 可以下降，但历史 cursor 未追平前，Phase 1 的趋势窗口仍来自延迟区块。继续扩大单轮区间会重新放大公共 RPC 的限流、延迟和 SQLite 后处理压力。

系统需要同时满足两个不同事实：最新链上趋势是否新鲜，以及历史区间是否完整。单一游标和单一 source-health 无法分别表达这两个事实。

## Proposal

在 Phase 0 和 Phase 1 各自现有 collector 与 SQLite 单写者边界内增加两个顺序车道：

- realtime lane 每个到期 tick 优先运行，从 confirmed tip 附近建立连续覆盖，并持久化 `realtime_cursor` 与不可向后移动的 `realtime_start_block`；
- backfill lane 保留并继续推进旧 `last_confirmed_block`，同时镜像为 `backfill_cursor`，以固定的 `realtime_start_block - 1` 为终点，按独立有界 cadence 补齐历史；
- `history_complete` 只在 backfill 连续覆盖抵达该固定边界后成立；链尖继续增长不会扩大历史 gap；
- 现有 `robinhood_chain` 与 `robinhood_chain_phase1` health 行只代表 realtime freshness，backfill 使用独立 health 行；
- Phase 1 审计增加 additive `collection_lane` provenance，Phase 2 只读取 `realtime` 审计。历史回填可以重算窗口但不能生成当前 shadow 草稿；
- 每个 batch 的数据、lane cursor 和 coverage 状态在同一事务提交。realtime 失败时不让 backfill 抢占优先级；backfill 失败不会撤销已提交的 realtime 结果。

新数据库从 realtime coverage 起点前一块初始化 backfill cursor，因此默认没有人为扩大历史范围。已有数据库原样继承旧 cursor。旧 `last_confirmed_block` 不指向 realtime tip，使旧版本回滚仍从未完成的历史位置继续，不会永久跳过 gap。

如果进程长时间停止，旧 realtime cursor 与 tip 的距离可能超过单轮有界预算。只有新长驻进程中每个 collector 的第一次实际尝试可以从新的 tip 窗口恢复；该权限在尝试开始时消耗，即使尝试失败也不会在同一进程再次授予。后续同进程容量越界必须在任何数据、cursor 或 coverage 状态写入前失败，并通过 realtime health 暴露新鲜度不足。手动 one-shot collector 默认允许一次恢复 rebase。

Phase 1 的 V4 realtime 扫描按每个有界 block chunk 对已验证 PoolManager 发出一次仅含 swap topic 的查询。返回的 PoolManager 地址和 swap topic 必须严格匹配；已登记但非稳定币池和格式合法但本地未知的 pool key 被过滤，已登记稳定币池进入解码，畸形 pool key 或已登记但身份冲突的池使整个批次失败。非 V4 分组、单 SQLite writer、事务 cursor、backfill 顺序与 Phase 2 realtime-only provenance 不变。

## Alternatives considered

- 保持 Revision 6 单游标直到自然追平：实现最简单，但在追平前不能把实时 freshness 与历史 completeness 分开，也无法马上获得最新趋势。
- 把 `catch_up_blocks_per_tick` 提高到 5,000 或 10,000：未选择，因为现场已经证明公共 provider 在更低压力下会产生 429/403，且 Phase 1 解码、流动性读取与窗口重算成本随区间增长。
- 直接把旧 cursor 跳到 confirmed tip：未选择，因为会把历史缺口永久隐藏，并破坏审计与回滚。
- 多进程并发写同一个 SQLite：未选择，因为会引入 writer contention、游标与窗口原子性风险。读取并行和独立 staging 可以在未来单独决策，但不是本次必要条件。

## Risks

- 每个 collector tick 增加额外 RPC 工作；通过 realtime-first、独立 backfill cadence、原有请求上限和独立 backfill health 控制压力。
- Phase 1 的池发现与 swap 扫描有时间依赖，不能把历史区间任意乱序分片；本次仍保持单 cursor 顺序回填。
- 现场证明 Phase 1 realtime 扫描和同轮 backfill/Phase 2 barrier 的总耗时可能让链头增长超过下一轮 bounded capacity。Revision 8 已在目标 sidecar 上证明同进程不会再次 rebase，且容量越界会在 cursor/coverage 写入前失败；但它没有证明连续 realtime 完成与 gap 单调收敛，因此本决策继续保持 `proposed`。
- additive audit column 会在新代码首次打开现有数据库时执行 SQLite schema write，因此现场迁移必须在备份、身份确认和单写者停机条件满足后另行批准。
- Revision 7 会改变 Phase 2 freshness 的证据来源，现场必须提升 `field_run_revision`，旧 epoch 不得计入新实现的 72 小时连续门禁。

## Verification

- Source/unit: cursor migration、固定 gap、边界封口、同进程容量失败不推进、首次尝试权限失败后仍被消耗、V4 topic-only 混合池过滤、异常 V4 响应原子失败、backfill health 隔离和幂等重放测试。
- Integration: Phase 2 只消费 realtime audit；backfill qualified window 不物化草稿。
- Lifecycle: realtime 先于 backfill；shadow daemon 与普通 trade daemon 各自在进程内只给每个 collector 首次尝试授予 rebase 权限；outer daemon 仍 single-flight，并在停机时排空当前 collector。
- Repository: `pnpm lint`、focused compiled tests、`pnpm verify`、decision validator 和 `git diff --check`。
- Deployed/field: Revision 8 在独立 shadow PID `20404` 和 v12 epoch 上完成一次成功 realtime/backfill cycle。Phase 0/Phase 1 各推进 1,980 个历史块，固定起点分别为 `51,451,441` 和 `51,452,523`；下一同进程 attempt 没有 rebase，而是分别以 capacity 2,000/1,000 fail-closed。三库 `quick_check=ok`，Phase 1 无重复 audit，v12 无 alert 或重复 draft，现场边界无 429/403。由于没有三次连续 realtime success，也没有两个 due backfill gap 下降样本，field acceptance 失败，sidecar 已停止。

## Rollback

停止 Revision 7 sidecar 后恢复旧代码。旧代码忽略 additive state keys 和 audit column，并从仍表示历史进度的 `last_confirmed_block` 继续单游标扫描。无需删除新列、cursor、事件、审计或 readiness 数据。若现场已经开启新 Phase 2 epoch，回滚后必须再使用新的 `field_run_revision`，不得把不同采集语义的运行合并到同一 readiness epoch。
