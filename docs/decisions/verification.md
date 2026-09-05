# 验证与发布决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-07-26 — 发布验证使用单一 verify 入口

- 状态：已由 2026-08-09 的分层验证门禁决策取代。
- 决定：常规完整门禁只运行 `npm run verify`。`native`、`ripgrep` 和 development SQLite 由 `test:runtime` 分进程串行调度；packaged SQLite 在 Windows package 生成后只测试打包 Electron；E2E 复用该构建产物。
- 高成本边界：默认不运行独立 benchmark-cases、任何 benchmark preset、Docker worker/image、外部 benchmark 或真实 Provider 测试。确定性的 benchmark manifest/checksum/路径安全用例已经属于 `npm test`；其他工作负载只有用户明确要求时才执行。

## 2026-07-26 — 201+ 分页不增加 Electron E2E 数据灌入

- 状态：接受现有覆盖，不新增高数据量 Electron E2E。
- 决定：Session 和 Message 的 201+ 边界继续由 repository/application 与 renderer store 的确定性测试覆盖，包括稳定 cursor、加载更早、prepend/upsert 和跨首屏选中恢复；Electron E2E 只保留代表性的分页交互，不在每次 `verify` 中创建数百条完整 Durable Session 数据。
- 理由：分页边界和排序逻辑在无时序噪声的下层测试中可穷尽断言；Electron 层的大批量数据准备显著拉长串行门禁，但新增的行为覆盖很少。当前 E2E 仍验证真实 IPC、SQLite、renderer 与控件接线。
- 重新评估条件：分页 IPC 与 repository/store 之间出现真实接线回归、引入虚拟列表或分页协议变化，或 CI 能提供低成本预置数据库 fixture。

## 2026-07-27 — 内置评估系统归档并从产品移除

- 状态：已采纳。
- 决定：在 `archive/integrated-benchmark` 分支保留完整快照，从主产品删除 case/runner/grader/metrics、Docker worker、Provider proxy、专用构建与命令、Headless benchmark protocol 和对应依赖。通用 Headless CLI/API、runtime identity、trace、usage/tool 统计与 Electron parity 保留。
- 理由：评估系统与产品 runtime、消息契约、构建、测试和文档高度耦合，导致本体复杂度与改造成本持续上升。评估工程不应再定义产品内部协议或引入专用 canonical message kind。
- 后续边界：如重启自动评估，在独立仓库中实现，只通过稳定 Headless 入口黑盒调用 Zch Coding Agent；产品仓库不再承载评估数据集、grader 或 worker 部署系统。

## 2026-08-09 — 日常检查与合并门禁分层

- 状态：已采纳；取代 2026-07-26 “每次阶段完成只运行完整 verify” 的执行频率，完整门禁覆盖范围不缩减。
- 日常门禁：`npm run check` 并行运行 lint、format check、typecheck 和确定性 Vitest。并行任务互不取消，全部结束后按任务分组输出失败；这里追求一次收集完整的低成本诊断，而不是全局首错退出。
- 合并门禁：`npm run verify` 仅在合并、发布或显式要求完整验证时运行；它在 `check` 之上继续覆盖分进程 runtime smoke、Desktop/Headless build、Windows package、packaged SQLite 和 Electron E2E。E2E 不从产品门禁移除，只从每次普通开发修改的必跑路径移出。
- CI 编排：普通分支 push 只执行快速检查；PR、`master` push 和手动触发将 runtime、E2E、package smoke 分配到独立 Windows runner，并禁用 matrix fail-fast，使互不依赖的失败能在同一次 workflow 中全部呈现。E2E runner 自行构建应用，package runner 自行构建与打包，以少量重复构建换取隔离和更短墙钟时间。
- 稳定性边界：Playwright 继续单 worker；本地完整门禁也不让 E2E 与 electron-builder 在同一 checkout 并发，避免共享构建目录、native rebuild 和 Windows 文件锁造成非确定性失败。不使用 PR 的直接合并必须在本地先运行 `npm run verify`，远端 `master` 门禁只提供合并后保护。
