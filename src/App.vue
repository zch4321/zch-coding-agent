<template>
  <main class="shell" data-testid="app-ready">
    <header>
      <p class="eyebrow">MY CODING AGENT</p>
      <h1>安全基线已就绪</h1>
      <p class="summary">
        当前阶段只提供隔离的桌面外壳。Agent、工作区和模型能力将在后续阶段通过受控接口接入。
      </p>
    </header>

    <section class="status-card" aria-labelledby="baseline-title">
      <div>
        <p class="status-label">P0</p>
        <h2 id="baseline-title">安全与工程脚手架</h2>
      </div>
      <span class="status-pill">BASELINE</span>
    </section>

    <ul class="checks" aria-label="安全基线状态">
      <li><span aria-hidden="true"></span>Renderer 与 Node.js 隔离</li>
      <li><span aria-hidden="true"></span>窄 preload 能力白名单</li>
      <li><span aria-hidden="true"></span>内容安全与导航限制</li>
      <li><span aria-hidden="true"></span>测试、构建与清理门禁</li>
    </ul>
  </main>
</template>
