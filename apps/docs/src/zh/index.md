---
layout: home

hero:
  name: King AI
  text: 面向团队协作的本地 BYOA 智能体
  tagline: 配对本机，运行本地 Claude 或 Codex 智能体，并通过 GUI runtime 协调多人协作。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 打开 King AI
      link: https://king-ai.congrongtech.cn
    - theme: alt
      text: CLI 参考
      link: /zh/guide/cli

features:
  - title: 配对本地电脑
    details: 只需配对一次，就可以复用同一个本地 daemon 执行后续智能体任务。
  - title: 使用自己的引擎
    details: King AI 调用本机已登录的 Claude Code 或 Codex CLI，不把模型凭据代理到服务器。
  - title: 协调一个团队
    details: 内置角色、任务卡片、评审、交接和人工决策门，让多智能体工作可追踪。
  - title: 状态留在本地
    details: 配对、会话、智能体 home 和运行时状态都存放在本机 King AI home 中。
---

## 快速路径

先检查本地引擎：

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --doctor
```

在 <https://king-ai.congrongtech.cn> 打开 GUI，复制配对命令并启动本地 daemon：

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair 'king-ai://pair?...'
pnpm dlx @suwujs/king-ai@latest agent computer
```

开发本仓库：

```sh
pnpm install
pnpm verify
pnpm docs:dev
```
