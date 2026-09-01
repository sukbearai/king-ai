# Decision: Robinhood Phase 0 与 Phase 1 按 RPC 所有权并行调度

Status: implemented

## Problem

Robinhood shadow daemon 原先按 Phase 0、provider cooldown、Phase 1、Phase 2 串行执行。Revision 5 已把 Phase 1 单轮 RPC 请求量压缩到公共 provider 可以短窗成功的水平，但一个完整周期内链的 confirmed target 增长仍可能超过 Phase 1 每轮 1,980 个区块的净推进量，积压无法稳定收敛。

直接提高 `catch_up_blocks_per_tick` 会重新放大 `eth_getLogs` 配额风险，也不解决 Phase 0 与 Phase 1 等待彼此的问题。现场配置已经为两个阶段分配不同 RPC，因此调度所有权需要利用这个边界，同时保护继承或共享 provider 的旧配置。

## Decision

当 Phase 0 与 Phase 1 解析后的 RPC endpoint 集合互不重叠时，同一个 daemon cycle 并行启动到期的 Phase 0 与 Phase 1 collector。daemon 是两个任务的唯一 owner；外层 cycle 保持 single-flight，并在两个结果均完成后才运行 Phase 2。任一阶段失败会被独立记录，不会取消另一个已启动阶段。

endpoint overlap 使用已有的 sanitized RPC 表示比较，忽略凭据、query、fragment 和末尾斜杠。无效 URL 会统一映射为保守的共享值。当 endpoint 集合有任何重叠时，继续执行 Phase 0 -> 可中断 provider cooldown -> Phase 1 的 Revision 5 串行路径。缺省或空 `phase1.rpc_urls` 继续继承 Phase 0 endpoint，因此旧配置不会无意获得新的跨阶段并发。

收到停机信号后，daemon 不再启动新的 Phase 0、Phase 1、Phase 2 或 X 工作，等待已经启动的 chain collector 与独立 X collector 完成其有界 RPC/retry 路径，再释放 PID lock。Phase 2 只消费完成后的 Phase 1 持久状态；X 继续独立 single-flight，且不进入链上趋势评分。

该决定不改变 Phase 0/Phase 1 cursor、SQLite schema、RPC retry、单次日志区间、2,000-block catch-up 上限、Phase 2 readiness 或任何 delivery/trading capability。

## Alternatives considered

- 把 Phase 1 catch-up 上限继续提高到 2,000 以上：未选择，因为公共 RPC 已在较低请求压力下出现 429，扩大区间会把吞吐问题重新转化为配额失败。
- 购买或接入更高配额 RPC：可作为运维替代方案，但当前没有已授权的付费 provider、凭据或稳定 SLA，不能作为代码闭环证据。
- 为两个阶段建立固定 provider 时间片：未选择，因为在 endpoint 已隔离时仍人为串行，无法消除当前主要等待时间。
- 无条件并行 Phase 0 和 Phase 1：未选择，因为继承配置会让两个阶段共享同一 provider，并产生未经验证的跨阶段突发。

## Consequences

- 使用隔离 RPC 的 Phase 0 与 Phase 1 不再支付彼此的串行耗时，Phase 2 仍以两阶段都结束作为一致性 barrier。
- 共享、继承、凭据变体或 query 变体 endpoint 保持 provider cooldown，兼容旧配置并避免新增并发压力。
- 两个不同 URL 仍可能由同一上游基础设施提供服务，因此现场 source health 与 lag 仍是最终容量证据。
- 停机需要等待已经进入的外部 RPC 调用完成，由现有 request timeout 与 bounded retry 保证最终可排空。

## Verification

- RED：修改前 focused test 只观察到 `phase0:start`，没有并行启动 `phase1:start`；停机排空测试因 Phase 1 从未启动而无法结束。
- Source tests：disjoint endpoint 并行开始、sanitized overlap 保持串行 cooldown、Phase 2 等待两个阶段、单阶段失败不取消另一阶段、停机在 in-flight drain 后释放 lock；focused Robinhood tests 66/66 通过。
- Repository checks：`pnpm lint`、`pnpm verify`、英中 VitePress build、`git diff --check` 与 decision validator 通过。
- Deployed shadow：`dev.king-ai-robinhood-shadow` 从 PID `76335` 滚动到 `48861`，原 trade daemon 保持 PID `97500`。日志连续出现 `chain stages parallel rpcSets=disjoint`。无新增 429/403，Phase 0 lag `212,994 -> 212,873 -> 212,008 -> 211,421`，Phase 1 lag `465,988 -> 465,264 -> 465,131 -> 464,268 -> 463,681`，均满足至少三个连续下降区间。
- Phase 2 新 epoch `phase2-v10-rpc-parallel` 当前仍为 `collecting`，source error rate 为 0，`liveDeliveryAuthorized=false`；72 小时 readiness、人工 review 与 live delivery approval 继续由 Phase 2 decision 单独控制。

## Rollback

将 `phase1.rpc_urls` 删除、置空或配置为与 Phase 0 重叠，使新版本自动回到 Revision 5 串行路径；也可回滚 daemon 代码并保留全部 SQLite 数据。回滚不需要 schema migration，不删除 cursor、source health、audit 或 readiness 记录，也不改变 delivery mode。
