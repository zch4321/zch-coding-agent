# 视觉、响应式与可访问性

本文保留布局和验收要求；返回[前端总览](../frontend-spec.md)。样式入口见 [Renderer 地图](../code-map/renderer.md)。

## 视觉规范

### 主题范围

- 当前实现和验收范围为亮色主题。
- 暗色主题单独设计和验收，不要求通过简单反色生成。
- 当前亮色风格参考 VS Code Light，内部控件采用克制圆角。

### 亮色 Tokens

| Token            | 值        | 用途                  |
| ---------------- | --------- | --------------------- |
| `background`     | `#FFFFFF` | 对话、viewer 主背景   |
| `surface`        | `#F6F8FA` | 顶栏、侧栏、次级面板  |
| `canvas`         | `#F3F3F3` | 应用底色              |
| `border`         | `#D0D7DE` | 分割线和控件边框      |
| `text-primary`   | `#24292F` | 主文本                |
| `text-secondary` | `#57606A` | 次级文本              |
| `text-muted`     | `#6E7781` | 提示和 metadata       |
| `accent`         | `#0969DA` | 主操作和活动状态      |
| `success`        | `#1A7F37` | 成功                  |
| `warning`        | `#9A6700` | 警告                  |
| `danger`         | `#CF222E` | 拒绝、失败、Yolo 风险 |

### 字体与图标

- UI：`Inter, system-ui, Segoe UI, sans-serif`。
- 代码：`Cascadia Code, Consolas, monospace`。
- 图标统一使用一个 SVG/icon font 方案，默认 16px。
- 不使用 `□`、`▢`、`＋` 等字符模拟正式图标。
- 图标与文字 gap 为 6-8px，必须共享 flex center 对齐。

### 圆角与间距

- 小控件：8px。
- 按钮、tab、工具卡：10-12px。
- 对话输入区和大卡片：14-16px。
- 应用最外层无假圆角和外 margin。
- 基础间距使用 4px 倍数；常用值为 8/12/16/24px。

## 尺寸与响应式

目标尺寸：

- 默认：1120×760。
- 标准验收：1280×800、1440×900。
- 建议最小窗口：960×640。

宽度行为：

- 宽屏：项目侧栏、对话区、Artifact 侧栏同时显示。
- 空间不足时优先折叠 Artifact 侧栏，但顶栏保留重新打开入口。
- 更窄时允许折叠项目侧栏，但新对话和搜索仍可通过入口访问。
- 禁止使用 `display:none` 永久隐藏功能且不给恢复入口。

默认尺寸建议：

- 项目侧栏：240px，可在 220-300px 范围调整。
- Artifact 侧栏：460px，可在 380-600px 范围调整。
- 对话工作列最小宽度：480px。
- 对话输入区只占对话工作列宽度，不参与三栏的跨栏布局。
- Terminal 默认高度：对话工作列 35%，并始终排列在完整对话区之后。

## 可访问性与安全验收

- 所有 icon-only 按钮有稳定的 `aria-label` 和 tooltip。
- 键盘可访问顶栏、侧栏、消息、tab、审批和设置。
- focus ring 清晰可见，不只依赖颜色变化。
- 文本和背景满足 WCAG AA 常规文本对比度。
- 状态不能只通过红/绿颜色表达，必须同时有文本或图标。
- modal 打开时焦点被约束；关闭后返回触发按钮。
- 危险操作默认焦点不得落在确认按钮。
- Approval args/reason/policy signals 与 Git Diff 使用文本绑定，不通过 raw `v-html`。
- Markdown renderer 禁止 raw HTML 和 `javascript:` 等危险协议。
- renderer 不 import Electron/Node，不直接读取 workspace 或密钥。
