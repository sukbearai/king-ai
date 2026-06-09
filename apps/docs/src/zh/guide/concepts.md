# 核心概念

## 设计范式：Agentic Engineering

King AI 构建在 **Agentic Engineering(智能体工程)** 范式之上：当大语言模型成为主要的推理引擎,源代码不再是「系统本身」,而退化为模型在推理循环中随用随弃的临时工具。交付方式从 `意图 → 软件 → 结果` 转变为 `意图 → 智能体 → 结果`——人类陈述目标与约束,智能体规划、执行、验证并交付结果,人类对结果进行审计。该框架参考 Cao《The End of Software Engineering》([arXiv:2606.05608](https://arxiv.org/abs/2606.05608))。

在该模型中,一个智能体系统是四元组 **A = (M, T, M, Π)**,King AI 与之逐项对应：

| 概念 | 在 King AI 中 |
| --- | --- |
| **M** — 推理引擎 | 本地 Claude Code / Codex CLI 作为大模型,另有小模型负责收件箱 triage |
| **T** — 可执行工具 | `king-ai` 运行时 CLI(`reply`、`task`、`card`、`doc`、`recall`…)、host SDK 与远程诊断命令 |
| **M** — 记忆 | 每个智能体的持久记忆(`memory/MEMORY.md`)加上跨会话的[情景召回](#情景记忆) |
| **Π** — 规划 | 收件箱 triage、任务路由、自动委派,以及协调者智能体把意图分解为分配的工作 |

人类的角色被重新定义为 **意图架构师、协调者与结果审计者**,而非代码作者：你陈述需求、塑造团队如何协作,并在[协作层](#协作层)所强制的决策门处批准结果。

## Runtime 边界

King AI 分为两侧：

- 远端 runtime server 负责配对、浏览器侧状态、wake 事件、消息队列、卡片、任务、决策和状态快照。
- 本地 computer daemon 负责本地执行。它调用已安装的 Claude Code 或 Codex CLI，写入本地运行时状态，并在允许的本地 workspace 中执行智能体工作。

这种边界让模型凭据和引擎会话保留在本地，同时 GUI 仍然拥有共享协作账本。

## Agent Runner

每个远端智能体对应一个本地 runner。Runner 会通过轮询或 SSE 接收 wake 事件，读取未读消息和分配的工作，先用小模型判断是否需要行动，再在需要处理时调用大模型。

每个智能体的 home 都位于 King AI home 下，因此会话、技能、状态文件和 workspace 可以按智能体隔离。

## 情景记忆

除了每个智能体私有的 `memory/MEMORY.md`，运行时还维护一份**跨会话情景记忆**。每条人类与智能体消息都会被镜像进 SQLite 后端运行时内的 FTS5 全文索引，与实时会话缓冲区相互独立。由于该索引是增量的，它在会话被清空后依然保留，因此团队会随时间累积可检索的经验。

智能体通过 `king-ai recall <query> [--limit n] [--conversation <id>]` 查询：它执行带排名的全文检索，返回命中片段及其所属会话和作者。用它来取回过往决策、之前的回答或更早会话的上下文，而不必重新推导。这把智能体模型中的 **M(记忆)** 组件落实为持久、可检索的经验，而不仅是当前的上下文窗口。

## 协作层

King AI 把工作建模成一个小型软件团队。内置角色包括 planner、builder、reviewer、tester、ops、researcher、doc-writer 和 summarizer。Workflow 可以分配任务、请求评审、创建交接，并发起人工决策。

模型仍然负责策略和内容；系统负责身份、归属、幂等、任务状态流转和持久审计记录。

## GUI 卡片

GUI 把工作展示为卡片：任务、文件、交接、评审、决策、initiative、计划和运行历史。智能体可以通过 runtime 命令创建和更新卡片，人类也可以在同一个 GUI 中指导或批准工作。

## 本地状态

新安装使用 `~/.king-ai` 作为本地 home。配对 token、每个智能体的 home、会话、triage 状态、heartbeat 文件和 host event 日志都会存放在那里，除非通过 `KING_AI_CONFIG_DIR` 覆盖路径。
