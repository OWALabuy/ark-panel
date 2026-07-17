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

## 复验

该命令会触发一次真实的 `paneltest` 模型调用和一个无副作用的 `printf` 工具调用，必须显式开启探针：

```sh
npm run test:stream-probe
```

成功输出只含版本、事件计数和连接状态，不打印 token、prompt、工具 stdout 或 Gateway 密钥。OpenClaw 版本升级后必须先重新运行此探针，再调整版本门禁。

## 降级边界

流式观察器只负责体验，不负责完成判定。认证失败、WebSocket 断开、事件丢失或服务重启都不得重发请求或破坏 run；生成继续由原有 CLI 提交与 trajectory watcher 监督。最终 transcript 仍经过完整 entry 校验和原子提交，正常完成时替换临时预览。
