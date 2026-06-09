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

## GUI 与 daemon 如何通信

浏览器 GUI 和本地 daemon **从不直接互联**。它们通过远端 runtime 中转——一个 Cloudflare Worker(Hono 应用),其后是**每个租户一个的 `GuiState` Durable Object**,作为会话、消息、任务、卡片、智能体注册表和状态的唯一持久账本。三类客户端都用 HTTPS 与同一个 Worker 通信：

| 客户端 | 访问 | 用途 |
| --- | --- | --- |
| 浏览器 GUI | `/gui/*` | 读状态、建会话、发送人类消息 |
| 本地 daemon(`king-ai agent computer`) | `/api/*`、`/runtime/*` | 配对、签发 token、接收唤醒、回传回复/状态/事件/run |
| 本地智能体(Claude / Codex) | 经 PATH 上的 shim 访问 `/runtime/cli` | 智能体执行的每一条 `king-ai <cmd>` |

**不开端口穿透 NAT。** 本地机器从不是服务器——它始终主动外拨。每个 agent runner 在启动时会向 `GET /runtime/wake-stream` 打开一条长连的 **Server-Sent Events** 流并保持。Durable Object 在内存里持有这条连接的 writer(`waiters`),因此可以随时向流里下推。这就是云端如何触达 NAT 或防火墙后面的笔记本。

一条人类消息的端到端流程如下：

```text
浏览器 ──POST /gui/message──▶ Worker ──▶ GuiState DO
                                            │ 追加消息、持久化
                                            │ broadcast { event: "wake", conversationId, messageId, agentId }
                                            ▼
                            wake 帧 ──▶ daemon 打开的 /runtime/wake-stream(SSE)
                                            ▼
                  AgentRunner：GET /runtime/inbox → 小模型 triage → 本地 Claude/Codex 一轮
                                            ▼
                  POST /runtime/cli { argv: ["reply", convId, text] } ──▶ DO 追加回复、持久化
                                            ▼
浏览器 ◀──GET /gui/state──── Worker ◀────── DO（此时已显示回复）
```

**身份与隔离。** 配对用一次性配对码(`POST /api/computers/pair`)换取长期 device token,保存在 `~/.king-ai`。daemon 由它签发短期的每智能体 runtime token(`POST /api/agents/<id>/runtime-token`),用于授权 `/runtime/*` 调用。每个请求都被路由到 `GUI_STATE.idFromName(tenantId)`,因此每个租户得到一个隔离的 Durable Object——拥有各自的消息、智能体与状态。

**什么留在本地。** 模型凭据和引擎会话从不离开机器。Worker 只会看到运行时消息和状态变更;真正的 Claude/Codex 进程、它们的会话以及你的 workspace 全部只存在于你的电脑上。

## Agent Runner

每个远端智能体对应一个本地 runner。Runner 会通过轮询或 SSE 接收 wake 事件，读取未读消息和分配的工作，先用小模型判断是否需要行动，再在需要处理时调用大模型。

每个智能体的 home 都位于 King AI home 下，因此会话、技能、状态文件和 workspace 可以按智能体隔离。

## 情景记忆

除了每个智能体私有的 `memory/MEMORY.md`，运行时还维护一份**跨会话情景记忆**。每条人类与智能体消息都会被镜像进 SQLite 后端运行时内的 FTS5 全文索引，与实时会话缓冲区相互独立。由于该索引是增量的，它在会话被清空后依然保留，因此团队会随时间累积可检索的经验。

智能体通过 `king-ai recall <query> [--limit n] [--conversation <id>]` 查询：它执行带排名的全文检索，返回命中片段及其所属会话和作者。用它来取回过往决策、之前的回答或更早会话的上下文，而不必重新推导。这把智能体模型中的 **M(记忆)** 组件落实为持久、可检索的经验，而不仅是当前的上下文窗口。

## 技能自演化

智能体可以把一段行之有效的流程沉淀为可复用的**技能**，供后续会话使用：`king-ai skill save <name> --file notes/skill.md`（以及 `skill list`、`show`、`remove`）。学习到的技能存放在易失的智能体 home 之外，因此能在重启与 reset 后保留；daemon 在每次启动时把它们重新安装进 `.claude/skills` 和 `.codex/skills`——形成一个团队过程性知识随时间复利累积的学习闭环。保存会经过校验（名称 slug、大小与数量上限），且按智能体隔离。这把范式中「可自我改进的 skills」落实为持久、可复用的模块，而非用完即弃的上下文。

## 协作层

King AI 把工作建模成一个小型团队。**角色模板**是一套小而**领域无关**的词表，描述一个 agent **如何**参与工作流——它的协作行为，以及随之而来的能力与权限。内置模板有 `planner`、`builder`、`reviewer`、`tester`、`ops`、`researcher`、`doc-writer` 和 `summarizer`。Workflow 用它们按能力路由任务、请求评审、创建交接，并发起人工决策。

模板不是 agent。具体花名册把 agent 映射到模板，并且可以**把一个模板折叠进另一个**，而不是 1:1 配人——例如默认团队没有独立的 summarizer，收尾职责由 planner（King AI CEO）承担。领域 agent 也是同理：雅思 coach 是单 agent 工作流，在协作维度上复用通用的 `builder` 模板（它直接干活），而它的学科专长写在自由文本 role 里，不另造模板。这样模板集保持通用、可跨领域复用——**agent 懂什么**取决于它的 role 和所属的**工作流模板**，而不是协作词表。

在 IELTS Study 工作流中，coach 保持可见英文自然，把结构化标注放在隐藏的 `WordCards:` JSON 块里。JSON 里的 `sentences` 会把每个可见英文句子拆成 clauses：简单句也要有一个 clause；并列句、复合句、复杂句和并列复合句要覆盖每个有限动词主句、并列分句、从句或关系从句。每个 clause 都要提供一个逐字连续出现的简短 `core`，`phrases` 只标同一分句中的有用短词组。每个英文单词都可点击：`cards` 应为每个可见英文单词 token 提供结构化中文义、IPA 音标和音节拆分。runtime 信任 coach，不再拦截或拒绝回复，而是尽力渲染这个合同：能匹配上的句子/分句高亮和词卡就渲染，coach 漏掉的词就回退到自动生成的词卡，并在学习者看到回复前把隐藏的 JSON 块剥掉。

模型仍然负责策略和内容；系统负责身份、归属、幂等、任务状态流转和持久审计记录。

## GUI 卡片

GUI 把工作展示为卡片：任务、文件、交接、评审、决策、initiative、计划和运行历史。智能体可以通过 runtime 命令创建和更新卡片，人类也可以在同一个 GUI 中指导或批准工作。

## 本地状态

新安装使用 `~/.king-ai` 作为本地 home。配对 token、每个智能体的 home、会话、triage 状态、heartbeat 文件和 host event 日志都会存放在那里，除非通过 `KING_AI_CONFIG_DIR` 覆盖路径。
