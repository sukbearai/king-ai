# 部署与发布

本仓库通过 release tag 驱动发布。

## 本地检查

准备发布前先运行：

```sh
pnpm verify
```

根目录 build 会包含 CLI package、GUI worker 和文档站。

## 版本递增

使用下面任一脚本：

```sh
pnpm release:patch
pnpm release:minor
pnpm release:major
```

脚本会验证 workspace、递增版本、提交 `Release v%s`、打 tag `v%s`，并 push commit 和 tag。

## GitHub Actions 工作流

发布工作流位于 `.github/workflows/publish.yml`，只在 push 的 tag 匹配 `v*` 时运行。

Job 会执行这些步骤：

1. checkout 仓库。
2. 安装 pnpm 和 Node.js 22。
3. 使用 `pnpm install --frozen-lockfile` 安装依赖。
4. 读取 `packages/cli/package.json`。
5. 校验 tag 必须和 package version 完全一致，例如版本 `0.2.24` 必须使用 tag `v0.2.24`。
6. 运行 `pnpm verify`。
7. 把根目录 README 复制到 CLI package metadata。
8. 使用 provenance 发布 `@suwujs/king-ai` 到 npm；如果精确版本已经存在则跳过。
9. 校验 Cloudflare 和 auth 部署 secrets。
10. 同步 Worker secrets 到 Cloudflare。
11. 执行 `pnpm --filter @king-ai/gui-worker run deploy` 部署 GUI Worker。
12. 执行 `pnpm --filter @king-ai/docs run deploy` 部署文档 Worker。

## 必需的 GitHub Secrets

仓库需要配置这些 secrets：

- `NPM_TOKEN`：发布 `@suwujs/king-ai` 的 npm automation token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare account ID。
- `CLOUDFLARE_API_TOKEN`：具备 Worker deploy 和 secret 写入权限的 Cloudflare API token。
- `BETTER_AUTH_SECRET`：部署后 GUI 使用的 Better Auth secret。
- `BETTER_AUTH_URL`：部署后 GUI 的公开 auth URL。
- `AUTH_GITHUB_CLIENT_ID`：GitHub OAuth client ID。
- `AUTH_GITHUB_CLIENT_SECRET`：GitHub OAuth client secret。

GitHub Actions 自定义 secret 名称不能使用 `GITHUB_` 前缀。OAuth 凭据应存为 `AUTH_GITHUB_CLIENT_ID` 和 `AUTH_GITHUB_CLIENT_SECRET`；workflow 会把它们映射回 Worker secrets `GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET`。

## 发布与部署边界

GitHub Actions 会基于 pushed release tag 完成 npm publish、GUI Worker 部署和文档 Worker 部署。正常发布流程中不要在本地执行 npm publish 或直接部署 Worker。

仓库仍然保留了 `pnpm gui:deploy`、`pnpm --filter @king-ai/docs run deploy` 等本地 Worker 命令，用于有目标的维护操作；但生产发布应走 tag 驱动的 workflow，让 package 发布、secret 同步和 Worker 部署绑定到同一个已验证版本。
