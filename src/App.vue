<template>
  <main class="shell" data-testid="app-ready">
    <header>
      <p class="eyebrow">MY CODING AGENT</p>
      <h1>可观测地基已就绪</h1>
      <p class="summary">
        当前阶段已建立版本化契约、安全配置、受控 IPC 与离线 trace 能力。Agent
        和工作区工具将在下一阶段接入。
      </p>
    </header>

    <section class="status-card" aria-labelledby="baseline-title">
      <div>
        <p class="status-label">P1</p>
        <h2 id="baseline-title">共享契约与可观测地基</h2>
      </div>
      <span class="status-pill">BASELINE</span>
    </section>

    <ul class="checks" aria-label="安全基线状态">
      <li><span aria-hidden="true"></span>版本化 TypeBox 契约</li>
      <li><span aria-hidden="true"></span>safeStorage 密钥隔离</li>
      <li><span aria-hidden="true"></span>有界 JSONL trace 与 replay</li>
      <li><span aria-hidden="true"></span>安全 IPC 与插件 hook</li>
    </ul>
  </main>
</template>
