# GUI Runtime

GUI worker 是面向浏览器的 runtime app。它存储持久 GUI 状态、提供页面 shell、暴露配对 API、流式输出状态，并为卡片和 workflow 状态分发 runtime CLI 命令。

## 本地运行

在仓库根目录执行：

```sh
pnpm gui:dev
```

Wrangler 会打印本地 URL。默认开发地址通常是 `http://127.0.0.1:8787`。

## 配对面板

GUI 会展示两条命令：

- 首次配对命令，包含 `king-ai agent computer --pair ...`。
- 已配对电脑后续启动使用的命令。

在承载本地智能体的机器上运行配对命令。配对完成后，GUI 会等待 computer daemon 上线并上报可用引擎。

## 工作界面

GUI 提供：

- 对话和未读输入。
- 智能体 roster 和在线状态。
- 任务、文件、claim、评审、决策、initiative 和计划。
- 运行历史和 host command 输出。
- 开发和测试环境使用的 reset 控制。

## 部署

Worker package 位于 `apps/gui-worker`。本地开发使用 Wrangler，但生产发布由版本 tag 触发的 GitHub Actions 完成。正常发布流程中不要手动 npm publish，也不要直接部署 Worker。
