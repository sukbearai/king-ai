# 核心概念

## Runtime 边界

King AI 分为两侧：

- 远端 runtime server 负责配对、浏览器侧状态、wake 事件、消息队列、卡片、任务、决策和状态快照。
- 本地 computer daemon 负责本地执行。它调用已安装的 Claude Code 或 Codex CLI，写入本地运行时状态，并在允许的本地 workspace 中执行智能体工作。

这种边界让模型凭据和引擎会话保留在本地，同时 GUI 仍然拥有共享协作账本。

## Agent Runner

每个远端智能体对应一个本地 runner。Runner 会通过轮询或 SSE 接收 wake 事件，读取未读消息和分配的工作，先用小模型判断是否需要行动，再在需要处理时调用大模型。

每个智能体的 home 都位于 King AI home 下，因此会话、技能、状态文件和 workspace 可以按智能体隔离。

## 协作层

King AI 把工作建模成一个小型软件团队。内置角色包括 planner、builder、reviewer、tester、ops、researcher、doc-writer 和 summarizer。Workflow 可以分配任务、请求评审、创建交接，并发起人工决策。

模型仍然负责策略和内容；系统负责身份、归属、幂等、任务状态流转和持久审计记录。

## GUI 卡片

GUI 把工作展示为卡片：任务、文件、交接、评审、决策、initiative、计划和运行历史。智能体可以通过 runtime 命令创建和更新卡片，人类也可以在同一个 GUI 中指导或批准工作。

## 本地状态

新安装使用 `~/.king-ai` 作为本地 home。配对 token、每个智能体的 home、会话、triage 状态、heartbeat 文件和 host event 日志都会存放在那里，除非通过 `KING_AI_CONFIG_DIR` 覆盖路径。
