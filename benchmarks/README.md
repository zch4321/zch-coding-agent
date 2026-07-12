# Benchmark Worker

当前目录实现 Linux Docker execution boundary、BenchmarkCase v1、strict/repair-once runner、独立 grader container、硬门禁、L0–L5 scoring、trace/tool/usage/cost与 paired comparison，以及正式 benchmark命令和分层报告。容器中的 Agent 仍是 `electron/headless/` 构建出的同一个固定 Yolo bundle。

## 构建与验证

```powershell
npm run build:worker-image
npm run test:docker-worker
npm run test:benchmark-cases
```

镜像默认命名为 `zch-agent-headless:<HEAD 前 12 位>`，也可通过 `ZCH_WORKER_IMAGE` 指定。构建脚本把完整 HEAD 和 clean/dirty tree 状态注入 bundle 与 OCI labels。正式可比较 run 应使用 clean commit 和不可变 image digest。

`test:docker-worker` 是显式 opt-in，不进入 `npm test`、`npm run build` 或 Electron E2E。它构建镜像后运行五条真实 Docker trajectory：

- fake OpenAI-compatible Provider 经受限 proxy 触发 `apply_patch`，验证 Linux Runtime、identity、patch 和 secret redaction。
- attach/stdin 驱动一次 repair-once，验证首轮与修复 run 共用 container/session且只追加一次 harness feedback。
- 单独启动 grader并 inspect sandbox/mount，验证 private input只读、网络关闭且无 Docker socket。
- 完整执行 Agent → patch → strict grader → L5，验证 private样例和 check ID不进入 Agent trace。
- Provider 永久挂起，验证 wall timeout、stop/kill fallback、sandbox inspect 和 Agent/proxy/network 零残留。

已存在且可信的镜像可用 `ZCH_SKIP_WORKER_IMAGE_BUILD=1` 跳过重建。

## 正式命令

先从仓库中的可提交模板创建本地 Headless config。`benchmark-config.local` 已被 `.gitignore` 显式排除：

```powershell
Copy-Item benchmark-config.example.json benchmark-config.local
```

模板默认内容如下，可按需修改 Provider、模型和环境变量名称：

```json
{
  "schemaVersion": 1,
  "provider": {
    "id": "deepseek",
    "profile": "deepseek",
    "baseURL": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "reasoning": "off",
    "credentialEnv": "DEEPSEEK_API_KEY"
  }
}
```

构建与运行：

```powershell
$env:DEEPSEEK_API_KEY = '...'
npm run build-worker-image
npm run benchmark:smoke -- --config benchmark-config.local
npm run benchmark -- --config benchmark-config.local
npm run benchmark:full -- --config benchmark-config.local
npm run benchmark:external -- --config benchmark-config.local --seed trial-1
```

- `benchmark:smoke`：默认最多3个 case，每项1 trial。
- `benchmark`：完整 `core-harness-8`，每项3 trials。
- `benchmark:full`：完整 `core-harness-8`，每项5 trials。
- `benchmark:external`：最新 Monthly-SWEBench 8项与最新 SWE-rebench leaderboard 8项，每项3 trials。首次运行可传 `--seed`；A/B 的另一侧使用 `--cohort <上一轮 cohort.json>`，不得同时传 seed。

`benchmark:external` 默认在成功、失败或取消后删除本次进程新建或新拉取的 external 任务与派生镜像标签；运行前已经存在的镜像和 `zch-agent-headless` Runtime 不会删除。需要连续复用镜像时显式传入 `--external-image-retention keep`。该清理不会执行全局 BuildKit prune，以免影响其他项目的构建缓存。

四个命令都只构建轻量 CLI bundle，不自动构建 Docker image。默认 image为当前 commit对应的 `zch-agent-headless:<12位commit>`，可用 `--image`或 `ZCH_WORKER_IMAGE`指定。常用覆盖参数包括重复的 `--suite` / `--case`、`--trials 1..5`、`--protocol repair-once --feedback public|diagnostic`、`--price-snapshot`、`--output`以及显式开发fallback `--credential-mode direct`。默认 proxy模式只把真实key交给受限 Provider proxy。

运行进度写入 stderr，包括 external 候选项目与镜像准备、当前 case/project、trial 序号、L0–L5 结果、是否解决、耗时和缓存复用状态。stdout 仍只输出最终单行 JSON，便于脚本稳定解析和管道处理。

外部运行开始时解析最新 release，并把两个 dataset commit、adapter revision、随机 seed、case hash、官方任务 image digest、ZCH派生 image digest和最终16项写入 `cohort.json`。Monthly固定4项bugfix和4项non-bugfix；SWE-rebench按patch规模轮转；全 cohort 同仓库最多一项。无效字段、镜像不可用、资源越界和兼容性失败按固定随机顺序递补并记录排除原因，不执行prompt/test alignment、审核Agent或人工批准。每个新case/image只缓存一次baseline未解决与oracle已解决的机器兼容性检查。

真实数据源兼容验证使用 `npm run test:benchmark-external-real`，它会构建worker image并至少验证两个来源各一项的环境、overlay和baseline/oracle verifier接线；不进入默认 `npm test`，也不以skip测试占位。

默认输出位于 `benchmarks/results/<timestamp>-<preset>`。指定同一个 `--output`可恢复identity一致的中断运行；identity变化时拒绝覆盖。

## 凭据边界

`runDockerWorker()` 默认使用 `credential.mode = 'proxy'`。coordinator 为每次 run 创建 internal network 和随机 worker token；Agent 只有该 token，Provider proxy 才能读取真实 key。两个 secret 都通过 coordinator 私有临时文件挂载，不进入 Docker environment value、Headless config、JSONL 或 artifacts。Proxy container 可按显式配置加入 bridge 访问真实 Provider，Agent 不加入 bridge。

`credential.mode = 'direct'` 仅用于受控开发：真实 key 会作为只读单次 secret file 挂载给 Agent，由 entrypoint 转成 provider-scoped Headless 环境值。benchmark baseline 应使用 proxy 模式。

## 受限资源

coordinator 只接受固定 workspace、artifacts、config/task 和 credential mount，不暴露通用 mount 参数。Agent 使用非 root、read-only rootfs、drop all capabilities、no-new-privileges、默认 seccomp、PID/CPU/内存/tmpfs/wall/disk limits。无论正常完成、失败、取消还是超时，最终都会收集有界 stdout/stderr，删除 container/network/secret directory，并把清理状态写入 `worker-result.json`。

## Case contract 与私有评判数据

`manifests/core-harness-8/suite.json` 是当前冻结 suite index，每个 entry 固定 manifest SHA-256；manifest 再固定源码 archive、源码 tree、private evaluator spec 和 case image digest。`adapters/native.ts` 另外把 adapter revision 纳入 suite identity，因此 adapter 语义变化必须产生新的 identity。

公开 manifest 包含 task、repository provenance、setup、public checks、acceptance groups、feedback policy、modification scope、budgets 和 review record，但不包含 private spec 路径、隐藏命令、oracle patch 或 mutant patch。`toAgentCaseDescriptor()` 进一步只导出 Agent 真正需要的公开字段。

源码使用可审阅的 `zch-case-archive-v1` JSON archive。准备器校验 raw archive 与规范化 tree hash后才写文件，再创建只有一个 baseline commit 的新 Git 仓库，并删除 reflog、hooks、remote、tag 和不可达历史。Agent 可见树还会扫描私有字段和 grader/oracle/mutant 路径。

`private/core-harness-8/` 只供可信 coordinator/evaluator 和数据质量自检读取，并已从 Docker build context 排除。固定8项覆盖slug、chunk、retry、falsey配置优先级、monorepo最深路由、API兼容重构、有界长日志诊断和正确no-change；每项包含oracle和两个可通过公开检查但会被隐藏行为组拒绝的mutant。`test:benchmark-cases` 对baseline/oracle/mutant从pristine archive重复准备三次，签名不一致即判定flaky。这里的review字段只记录确定性自检，不是语义alignment或人工批准门禁。

外部 adapter 不把上游任务伪装成 native archive。Monthly Harbor环境和 SWE-rebench官方image先构建/拉取为 Linux/amd64任务image，再只叠加当前ZCH Headless runtime；Provider proxy仍使用通用worker image。Agent workspace位于任务原生路径的Docker named volume，保留symlink和执行位；gold/solution、test patch、测试ID及verifier配置只存在于grader私有缓存和挂载，Agent descriptor对外部case仅含problem statement、范围与预算。

## Runner protocol

`runBenchmarkTrials()` 默认执行 strict trial：Agent container退出后才收集 patch，isolated grader coordinator从 archive另建干净 workspace并在第二个 `network=none` container内评判。repair-once 通过固定阶段事件和 stdin决策通道，在同一 Headless session追加一次 `<benchmark_feedback>`，然后用另一份干净 evaluator workspace重评；公开反馈不含 private命令、输出、精确期望或 oracle。

每个trial会把公开case descriptor通过独立 `<benchmark_case>` Harness层注入首次模型请求。模型能看到public checks、允许/禁止修改的路径和资源预算；task仍保持独立user message，private spec、oracle和mutant不会进入descriptor。

每个 trial 写入独立 `.incomplete-*` staging，删除 workspace、扫描 Provider credential 泄漏并计算整棵 artifact checksum后才原子改名为 final。Resume 只复用 identity和 checksum都匹配的 complete final；遗留 staging、活跃容器和 continuation state永不复用。pass@k 会为每个 index重新准备 workspace并调用独立 worker。

Runner 从 runtime trace生成 `metrics.json`。Token按 main/approval/title/compression scope汇总，Provider未报告字段保持 `null`；工具按 stage/outcome/tool/effect计数，并附带 patch与 trajectory指标。传入 `priceSnapshot` 时，完整 snapshot写入 `price-snapshot.json`并以 hash固定在 trial identity；比较器逐字段校验 paired identity后才计算 resolve delta、95%区间和 safety/correctness/efficiency词典序结果。

Run-group artifacts按 `cases/<suite>/<case>/trials/trial-N/attempts/<phase>`分层。每个完整trial同时生成可导入消息语义的 `conversation.restricted.md` 和只读完整轨迹 `session-transcript.restricted.md`；后者包含工具、审批、内部编排、明文reasoning与Provider消息快照，不做敏感信息扫描或脱敏，用户必须自行负责本地保存和分享。两者均不进入shareable report，session transcript仍进入artifact hash但按精确路径从credential scan排除；其他worker/grader/artifact继续扫描。缺失trace metrics时run-group状态为`incomplete`，不会输出伪造的效率总计。

## Grader 与评分

Grader container为非 root、只读 rootfs、drop all capabilities、no-new-privileges、受限 CPU/内存/PID/tmpfs/wall且 `network=none`。它只看到 evaluator workspace、只读 private input和 output；Provider credential、Agent artifacts、Docker socket和宿主 home均不挂载。输出必须匹配完整命令计划，只保存命令结果、失败类别和 stdout/stderr hash。

评分先区分 unsupported、invalid、attempted与 graded，再应用 patch/scope/hygiene、Agent/grader sandbox、runtime identity、cleanup和credential hard gates。L0–L5依次表示无有效改动、合法 patch、setup/build通过、公开回归通过、部分行为组通过、全部 critical行为组通过；行为组做 macro-average，不按测试数量平均。`evaluation.json`可分享，private check细节只保存在权限受限的 `*.restricted.json`，`redaction.json`记录省略项。
