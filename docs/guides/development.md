# 开发环境与工作流程

返回[文档入口](../README.md)。开始修改前阅读 [AGENTS.md](../../AGENTS.md)，按任务从 [Code map](../code-map/README.md) 找到实现和测试。

## 环境与首次运行

主要开发和发布环境为 Windows x64、Node.js 24 与 npm，与 [CI](../../.github/workflows/ci.yml) 保持一致。Git 用于仓库和 Git Review；Provider 凭据只在运行需要时配置。

```powershell
npm ci
npm run dev
```

安装会运行 Electron 原生依赖安装步骤。开发入口是 Vite；Electron、Renderer、Headless 的构建配置分别见 [vite.config.ts](../../vite.config.ts) 和 [vite.headless.config.ts](../../vite.headless.config.ts)。运行后选择工作区和模型，操作见[配置指南](./configuration.md)。

## 分支与提交

使用适合当前任务的非 master 分支。从 master 开始时创建 `feat/`、`fix/`、`refactor/`、`docs/`、`test/` 或 `chore/` 分支。文档直接提交 master 的例外须由用户明确要求。完成后提交范围内的修改并推送当前分支；使用 Conventional Commit 风格的祈使句主题。

修改前检查工作树，保留不属于任务的编辑。测试和产品代码沿现有进程边界放置，公共函数/类需要职责注释；具体规则不在这里重复，以 AGENTS 为准。

## 选择验证命令

命令定义以 [package.json](../../package.json) 为准。

| 命令                     | 用途                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `npm run format`         | 格式化代码、配置与维护范围内的文档；有无关编辑时只格式化任务文件                     |
| `npm run format:docs`    | 只格式化项目说明、docs 与 Tooling 入口，不改 Prompt 资源                             |
| `npm run check:docs`     | 检查文档中的本地文件、图片、标题链接及检查器回归                                     |
| `npm run check`          | 日常门禁：并行 lint、format check、确定性 Vitest、typecheck 和文档检查，等待全部结果 |
| `npm run test:runtime`   | 独立进程运行 native PTY、ripgrep 与开发 SQLite smoke                                 |
| `npm run test:e2e`       | 先构建应用，再运行 Playwright                                                        |
| `npm run build`          | 类型检查、runtime smoke、应用/Headless 构建、Windows 打包与 packaged SQLite smoke    |
| `npm run build:headless` | 仅构建 Headless host，使用见 [Headless 指南](./headless.md)                          |
| `npm run verify`         | 合并/发布门禁：check、runtime smoke、打包和基于已构建应用的 E2E                      |

日常运行 `check` 前先格式化任务文件。仅在定位失败时单独跑底层命令；所选门禁成功后不重复已经包含的检查。跨模块回归要求见[测试指南](./testing.md)。

`test:real` 需要显式请求、外部凭据和付费 Provider，不属于常规开发、CI 或 verify；默认不要运行它。原生依赖和数据库启动问题见[排障指南](./troubleshooting.md)。

## CI 与发布

普通分支 push 运行快速检查；PR、master push 和手动触发还在独立 Windows runner 上验证 runtime、E2E 和 package。直接合并前仍需本地 `npm run verify`，避免完整检查直到 master 更新后才发现问题。

安装包输出到 `release/<version>/`。版本、tag 和 draft release 的完整步骤见[发布流程](../releases/README.md)，不要把发布动作混进普通文档或代码修复。
