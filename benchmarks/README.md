# Benchmark Worker

当前目录实现 M5.4 的 Linux Docker execution boundary，不负责 case manifest 或 grader。容器中的 Agent 仍是 `electron/headless/` 构建出的同一个固定 Yolo bundle；`benchmarks/worker/` 只负责部署、网络、资源和清理生命周期。

## 构建与验证

```powershell
npm run build:worker-image
npm run test:docker-worker
```

镜像默认命名为 `zch-agent-headless:<HEAD 前 12 位>`，也可通过 `ZCH_WORKER_IMAGE` 指定。构建脚本把完整 HEAD 和 clean/dirty tree 状态注入 bundle 与 OCI labels。正式可比较 run 应使用 clean commit 和不可变 image digest。

`test:docker-worker` 是显式 opt-in，不进入 `npm test`、`npm run build` 或 Electron E2E。它构建镜像后运行两条真实 Docker trajectory：

- fake OpenAI-compatible Provider 经受限 proxy 触发 `apply_patch`，验证 Linux Runtime、identity、patch 和 secret redaction。
- Provider 永久挂起，验证 wall timeout、stop/kill fallback、sandbox inspect 和 Agent/proxy/network 零残留。

已存在且可信的镜像可用 `ZCH_SKIP_WORKER_IMAGE_BUILD=1` 跳过重建。

## 凭据边界

`runDockerWorker()` 默认使用 `credential.mode = 'proxy'`。coordinator 为每次 run 创建 internal network 和随机 worker token；Agent 只有该 token，Provider proxy 才能读取真实 key。两个 secret 都通过 coordinator 私有临时文件挂载，不进入 Docker environment value、Headless config、JSONL 或 artifacts。Proxy container 可按显式配置加入 bridge 访问真实 Provider，Agent 不加入 bridge。

`credential.mode = 'direct'` 仅用于受控开发：真实 key 会作为只读单次 secret file 挂载给 Agent，由 entrypoint 转成 provider-scoped Headless 环境值。benchmark baseline 应使用 proxy 模式。

## 受限资源

coordinator 只接受固定 workspace、artifacts、config/task 和 credential mount，不暴露通用 mount 参数。Agent 使用非 root、read-only rootfs、drop all capabilities、no-new-privileges、默认 seccomp、PID/CPU/内存/tmpfs/wall/disk limits。无论正常完成、失败、取消还是超时，最终都会收集有界 stdout/stderr，删除 container/network/secret directory，并把清理状态写入 `worker-result.json`。
