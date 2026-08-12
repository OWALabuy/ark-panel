# OpenClaw 流式协议验收

验收日期：2026-07-17  
OpenClaw：`2026.6.11`  
测试 agent：无渠道绑定的 `paneltest`

## 结论

- 本机 Gateway 接受 `gateway-client/backend` + 共享密钥 + `operator.read`，无需伪造浏览器设备身份。
- `chat` 能提供 assistant 文本的合并增量快照；本次探针观察到 3 个文本事件。
- `session.tool` 能提供工具开始和完成事件；本次探针各观察到 1 个。
- 探针使用面板 idempotency key 校验 Gateway `runId`，结束后注销临时 session 并清理 artifacts。
- 浏览器不直连 Gateway；正式路径为 Gateway WebSocket → 面板内存 run 快照 → 已认证 SSE → 临时预览。

> 此文档只记录 2026-07-17 当次 read-scope 流式探针的事实，不是当前生产控制连接全部权限的证明。当前架构复用一条固定 OpenClaw `2026.6.11` 的本机控制连接，并要求 `hello` 精确授权 `operator.read`、`operator.write`、`operator.admin`；write/admin 对应生成、附件与临时 session 生命周期。该三 scope 契约已有 fake WebSocket 确定性测试，但本文件不虚构一次新的真实 runtime 验收；后续真实复验仍须使用无渠道绑定的测试 agent 并显式开启探针。

## 复验

该命令会触发一次真实的 `paneltest` 模型调用和一个无副作用的 `printf` 工具调用，必须显式开启探针：

```sh
npm run test:stream-probe
```

成功输出只含版本、事件计数和连接状态，不打印 token、prompt、工具 stdout 或 Gateway 密钥。OpenClaw 版本升级后必须先重新运行此探针，再调整版本门禁。

## 降级边界

流式预览只负责体验，不负责完成判定。认证失败、WebSocket 断开、事件丢失或服务重启都不得重发请求或破坏已接受的 run；其终态继续由 trajectory watcher 监督。生产连接同时承载控制 RPC，因此连接不可用时新的生成、附件和 lifecycle 操作会稳定失败，而不是自动换凭据或扩大权限。最终 transcript 仍经过完整 entry 校验和原子提交，正常完成时替换临时预览。`PANEL_OPENCLAW_STREAMING=0` 只关闭预览，不关闭该控制连接或撤销 read/write/admin。
