# OpenClaw 流式协议验收

> **历史证据元数据**
>
> - Date: `2026-07-17`
> - ark-panel commit: `ccd8b20`
> - OpenClaw version: `2026.6.11`
> - Status: `historical pass`
> - Superseded/current applicability: 本文件只保留当时 `operator.read` 探针与 CLI
>   提交路径的事实。当前实现改为一条精确 `operator.read/write/admin` 控制连接；
>   fake WebSocket 已自动覆盖，但真实三-scope Gateway 仍为 `unknown`。见
>   [acceptance matrix](README.md)。

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

## 当前 tool-result schema 探针（尚未实机执行）

`test:tool-result-schema-probe` 是 #27 的独立、默认关闭入口。它只回答真实
`2026.6.11` Gateway 上一次 `exec` 调用的事件顺序与 result 字段结构，不实现或启用
result/stdout 呈现，也不能代替 #48 的 bootstrap、skills 或 memory runtime 验收。

命令不会提供 agent、配置或 sessions root 默认值，也不会在 npm script 中自动开启
gate。运行前必须由人核对专用 agent、显式配置文件与隔离 sessions root，然后同时给出
环境 gate 和精确确认串：

```sh
PANEL_ALLOW_TOOL_RESULT_SCHEMA_PROBE=1 \
PANEL_TOOL_RESULT_SCHEMA_SESSIONS_ROOT=/explicit/openclaw/agents/panel-probe-example/sessions \
PANEL_TOOL_RESULT_SCHEMA_CONFIG_PATH=/explicit/openclaw/openclaw.json \
npm run --silent test:tool-result-schema-probe -- \
  --agent panel-probe-example \
  --expected-version 2026.6.11 \
  --scenario exec-printf-v1 \
  --max-tool-calls 1 \
  --cleanup delete-created-session-v1 \
  --confirm tool-result-schema:panel-probe-example:2026.6.11
```

这是模板，不是当前机器的已授权目标，不能直接照抄执行。两个敏感路径只通过环境变量
传入，受支持命令必须带 `--silent`，防止 npm 在 CLI 启动前回显它们。preflight 在创建 session 前
验证 strict JSON 配置、目标零 bindings、root 的 canonical 路径/dev/inode、固定版本和
Gateway 认证；创建一次性 session 后还要求 effective tool inventory **精确等于**
`{exec}`，否则零 send 并清理。发送内容固定，不接受 prompt 参数。完成必须同时看到
同一次调用的 sanitized terminal result shape 和权威 trajectory terminal；没有固定
`250ms` sleep，也不会重发。

临时 Gateway 必须以 `umask 077` 启动；sessions 根不得包含 session/artifact，只允许
owner-only、普通单链接且内容精确为空对象的 OpenClaw `sessions.json`。

`maxToolCalls=1` 和预期 args 都是观察后的失败关闭界限，不是执行前工具沙箱：错误命令或
第二个 start 被观察时，调用可能已经开始。因此当前入口不得直接在宿主运行；必须先增加
执行前 exact-command enforcement，或把整个临时 Gateway 放入仅暴露探针临时根的 disposable
OS/container sandbox。专用、零绑定 agent 和人工授权本身不能替代这条边界。输出只含固定 shape
种类、计数和字节数；不含配置/root、Gateway URL、凭据、session/run/call ID、tool 名、
prompt、args、result/stdout 值、动态 key、hash 或 artifact 名。失败只输出固定错误码。
直到一次获授权的实际运行产生日期化证据前，upstream result schema 仍是 `unknown`，
#27 仍保持 open。

## 降级边界

流式观察器只负责体验，不负责完成判定。认证失败、WebSocket 断开、事件丢失或服务重启都不得重发请求或破坏 run；生成继续由原有 CLI 提交与 trajectory watcher 监督。最终 transcript 仍经过完整 entry 校验和原子提交，正常完成时替换临时预览。
