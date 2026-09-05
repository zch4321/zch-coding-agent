# 配置与使用

返回[文档入口](../README.md)。能力条件见[产品范围](../requirements.md#当前能力与范围)，设置验收见[设置规范](../frontend/settings.md)。

## Provider 与模型

1. 选择工作区，在设置的供应商领域添加 Provider 类型、Base URL 和 API Key。
2. 刷新模型目录；不支持目录接口的服务可手工新增模型。选择启用模型，必要时填写上下文、输出、压缩阈值和 reasoning 能力。
3. 在模型领域选择主模型及其 reasoning；辅助模型用于自动起名与 Auto 审批，未配置时跟随当前模型。
4. 回到对话，确认当前 Session 的模型和权限模式后发送任务。

已保存的 API Key 不回显到 Renderer；界面只展示是否配置。模型角色与供应商表单分开保存；当前运行使用已冻结 route，设置修改不会静默替换进行中的请求。

## 权限选择

ReadOnly 限制副作用；Auto 先经过确定性策略，再对需要 review 的调用使用审批模型；Confirm 按规则请求人工审批；Yolo 跳过风险审批。所有模式仍校验参数与资源归属。具体例外和路径语义见[权限规范](../architecture/tools-and-permissions.md)。

命令与 PTY 是主机执行能力。工具修改采用最新内容和 last-writer-wins；对话回退不会恢复文件，工作树恢复由 Git 管理。Full Trace 是单独的敏感调试开关，不能用权限模式代替其告知。

## 命令与 Terminal

运行时设置中的“命令与终端 Shell”使用主进程发现的解释器。`Auto` 显示实际解析结果；显式选择失效时提示并临时回退，不改掉保存值。选择同时影响 `run_command.shell` 与之后新开的 Terminal，不影响直接 process、内部 Git 和已经运行的 Terminal。

## MCP stdio

当前通过 Electron userData 下的 `config.json` 中 `mcpServers` 配置服务器，然后在设置的集成领域重新加载、确认启动信任并启用。建议退出应用后编辑配置，避免与设置保存竞争；数据目录从设置中的“打开数据目录”定位。

以下为配置片段，合入已有配置，不覆盖其他字段。将示例脚本替换为实际 MCP server：

```json
{
  "mcpServers": [
    {
      "id": "example",
      "label": "Example tools",
      "description": "Workspace-local example MCP server",
      "enabled": false,
      "scope": "workspace",
      "transport": "stdio",
      "command": "node",
      "args": ["${workspace}/scripts/example-mcp.mjs"],
      "env": { "LOG_LEVEL": "warn" },
      "envFromHost": { "API_TOKEN": "EXAMPLE_API_TOKEN" },
      "startupTimeoutMs": 10000,
      "toolTimeoutMs": 30000
    }
  ]
}
```

敏感值用 `envFromHost` 引用启动应用时可用的主机环境变量，不写在 `env` 中。启动信任与实际外部工具调用的权限审批分开；当前支持 stdio，完整 schema 见 [shared/mcp.ts](../../shared/mcp.ts)。

## Skills 与 Agents

Skills 在集成设置中通过 HTTPS、文件选择器或用户目录扫描安装；新安装/首次扫描默认禁用，检查内容后显式启用。Agent 常驻摘要，正文通过 `read_skill` 按需读取，文件规范见[Skills 专题](../architecture/integrations.md)。

Subagent 默认关闭，在运行时领域配置开关、worker timeout 与 Session 容量；启用会增加 Provider 调用。模型领域配置模型池后，满足条件的 Desktop 主 Run 可以获得 Swarm 工具。父 Run 停止后已启动后台任务可继续运行；当前通过 Agent 的 background 工具取消，Agents 面板提供状态与详情。Headless 能力差异见[指南](./headless.md)。
