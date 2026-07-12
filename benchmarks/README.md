# Benchmark Worker

当前目录实现 Linux Docker execution boundary、BenchmarkCase v1 数据边界，以及 M5.6 strict/repair-once runner。容器中的 Agent 仍是 `electron/headless/` 构建出的同一个固定 Yolo bundle；正式隔离 grader 和 L0–L5 scoring 属于 M5.7。

## 构建与验证

```powershell
npm run build:worker-image
npm run test:docker-worker
npm run test:benchmark-cases
```

镜像默认命名为 `zch-agent-headless:<HEAD 前 12 位>`，也可通过 `ZCH_WORKER_IMAGE` 指定。构建脚本把完整 HEAD 和 clean/dirty tree 状态注入 bundle 与 OCI labels。正式可比较 run 应使用 clean commit 和不可变 image digest。

`test:docker-worker` 是显式 opt-in，不进入 `npm test`、`npm run build` 或 Electron E2E。它构建镜像后运行三条真实 Docker trajectory：

- fake OpenAI-compatible Provider 经受限 proxy 触发 `apply_patch`，验证 Linux Runtime、identity、patch 和 secret redaction。
- attach/stdin 驱动一次 repair-once，验证首轮与修复 run 共用 container/session且只追加一次 harness feedback。
- Provider 永久挂起，验证 wall timeout、stop/kill fallback、sandbox inspect 和 Agent/proxy/network 零残留。

已存在且可信的镜像可用 `ZCH_SKIP_WORKER_IMAGE_BUILD=1` 跳过重建。

## 凭据边界

`runDockerWorker()` 默认使用 `credential.mode = 'proxy'`。coordinator 为每次 run 创建 internal network 和随机 worker token；Agent 只有该 token，Provider proxy 才能读取真实 key。两个 secret 都通过 coordinator 私有临时文件挂载，不进入 Docker environment value、Headless config、JSONL 或 artifacts。Proxy container 可按显式配置加入 bridge 访问真实 Provider，Agent 不加入 bridge。

`credential.mode = 'direct'` 仅用于受控开发：真实 key 会作为只读单次 secret file 挂载给 Agent，由 entrypoint 转成 provider-scoped Headless 环境值。benchmark baseline 应使用 proxy 模式。

## 受限资源

coordinator 只接受固定 workspace、artifacts、config/task 和 credential mount，不暴露通用 mount 参数。Agent 使用非 root、read-only rootfs、drop all capabilities、no-new-privileges、默认 seccomp、PID/CPU/内存/tmpfs/wall/disk limits。无论正常完成、失败、取消还是超时，最终都会收集有界 stdout/stderr，删除 container/network/secret directory，并把清理状态写入 `worker-result.json`。

## Case contract 与私有评判数据

`manifests/core-24/suite.json` 是当前冻结 suite index，每个 entry 固定 manifest SHA-256；manifest 再固定源码 archive、源码 tree、private evaluator spec 和 case image digest。`adapters/native.ts` 另外把 adapter revision 纳入 suite identity，因此 adapter 语义变化必须产生新的 identity。

公开 manifest 包含 task、repository provenance、setup、public checks、acceptance groups、feedback policy、modification scope、budgets 和 review record，但不包含 private spec 路径、隐藏命令、oracle patch 或 mutant patch。`toAgentCaseDescriptor()` 进一步只导出 Agent 真正需要的公开字段。

源码使用可审阅的 `zch-case-archive-v1` JSON archive。准备器校验 raw archive 与规范化 tree hash后才写文件，再创建只有一个 baseline commit 的新 Git 仓库，并删除 reflog、hooks、remote、tag 和不可达历史。Agent 可见树还会扫描私有字段和 grader/oracle/mutant 路径。

`private/core-24/` 只供可信 coordinator/evaluator 和数据质量自检读取，并已从 Docker build context 排除。当前 3 个 bootstrap case 各自包含一个 oracle 和两个可通过公开检查但会被隐藏行为组拒绝的 mutant；`test:benchmark-cases` 对 baseline/oracle/mutant 从 pristine archive 重复准备三次，签名不一致即判定 flaky。

## Runner protocol

`runBenchmarkTrials()` 默认执行 strict trial：Agent container退出后才收集 patch，可信 native evaluator从 archive另建干净 workspace评判。repair-once 通过固定阶段事件和 stdin 决策通道，在同一 Headless session追加一次 `<benchmark_feedback>`，然后用另一份干净 evaluator workspace重评；公开反馈不含 private命令、输出、精确期望或 oracle。

每个 trial 写入独立 `.incomplete-*` staging，删除 workspace、扫描 Provider credential 泄漏并计算整棵 artifact checksum后才原子改名为 final。Resume 只复用 identity和 checksum都匹配的 complete final；遗留 staging、活跃容器和 continuation state永不复用。pass@k 会为每个 index重新准备 workspace并调用独立 worker。
