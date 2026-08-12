# 浏览器验收记录（2026-07-11）

> **历史证据元数据**
>
> - Date: `2026-07-11`
> - ark-panel commit: `cf67b56`（仓库中最早保存该结果的 snapshot）
> - OpenClaw version: 不适用（纯内存 browser fixture）
> - Status: `historical pass`
> - Superseded/current applicability: 已由 2026-08-12 起的可执行 Firefox 自动化
>   取代；本文件不得加入 2026-07-11 之后才实现的功能。当前状态见
>   [acceptance matrix](README.md)。

2026-07-11 使用 Firefox 152 + WebDriver，在 `test/browser-fixture.mjs` 提供的
纯内存脱敏数据上完成验收。fixture 不读取 agent 目录，也不连接 gateway。

已验证：

- 登录、Cookie 会话及三栏桌面布局；
- 退出登录，以及 active/reset 只读状态（禁用输入并显示 fork 引导）；
- 移动端 Agent → 会话 → 对话逐层导航及返回；
- 服务端搜索与命中摘要；
- 新建 panel 会话、fork、编辑重发；
- 新建与编辑 modal 的初始焦点、必填校验、取消、Escape 关闭及焦点恢复；
- SSE started/completed 状态、消息刷新；
- 斜杠命令在浏览器发请求前被拒绝，输入被保留且 transcript 不变化；服务端另有
  bridge 前拒绝测试；
- 生成按钮在运行中切换为可访问的“停止生成”，取消后保留输入以便重试；
- 页面轮询轻量 revisions API，检测变化后才刷新完整会话列表；
- 首次 `SESSION_BUSY` 后使用同一个幂等键重试成功；
- thinking、tool use、tool result 默认折叠；
- 所有动态内容使用 DOM text 节点，不解释为 HTML；
- 主要导航、搜索、消息输入、发送和 live status 均具有可访问名称或 live region。

当时保存的脱敏截图：

- [`ui-desktop.png`](../images/ui-desktop.png)
- [`ui-mobile.png`](../images/ui-mobile.png)
- [`ui-modal-desktop.png`](../images/ui-modal-desktop.png)
- [`ui-modal-mobile.png`](../images/ui-modal-mobile.png)

当时的 fixture 启动命令：

```sh
npm run build
node test/browser-fixture.mjs
```

上述命令只启动 fixture server，不是当前的自动 WebDriver suite。当前可重复命令为
`npm run test:browser`，见[当前自动化说明](browser-acceptance.md)。
