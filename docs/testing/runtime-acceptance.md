# 专用 runtime bootstrap 与 memory continuity 验收

> **Runbook metadata，不是执行结果**
>
> - Date: `2026-08-22`（runbook review）
> - ark-panel implementation: 本 runbook 同一工作项中的 native transcript 与受限 cache-cleanup revision
> - OpenClaw version: target `2026.6.11`
> - Status: `unknown`（本工作项未执行 live probe）

本探针逐次只验收一个显式目标。目标必须是配置中的 channel-free chat runtime，ID 为
`panel-<name>-runtime`、`panel-runtime-probe-<name>`，或兼容现有隔离 fixture 的 `paneltest`。
它不会从默认 home 推断 config、sessions 或 workspace，也不会自动开启 live gate。

## 人工前置确认

执行前，操作者必须逐项确认并记录：

1. 目标 agent ID、`openclaw.json`、目标 agent 的 `sessions` 根和 workspace 根均已明确；
2. `openclaw.json` 中 `bindings` 精确为 `[]`，且 `agents.list` 恰有一个目标 agent，workspace
   精确指向上述目录；目标没有任何 channel/cron/外部消息入口；
3. 两个根均由当前用户拥有、不可被 group/other 访问、不是 symlink；临时 Gateway 必须以
   `umask 077` 启动，sessions 根必须是该探针独占且不含其他 session、archive 或 metadata。
   OpenClaw 可保留一个 owner-only、普通单链接且 JSON 内容精确为空对象的 `sessions.json`；
   探针把这个空 registry 归一化为空状态，任何非空/额外键、宽权限或其它文件仍失败关闭；
4. workspace 已由操作者预置普通私有文件
   `memory/ark-panel-runtime-acceptance.md`，内容精确为：

   ```text
   # Fictional ark-panel runtime acceptance canary

   ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1
   ARK_PANEL_RUNTIME_ACCEPTANCE_RESULT_V1
   ```

5. 接受探针创建一次临时 session、发送一次固定虚构 prompt、调用一次 `memory_search`，并在
   终态或已确认 abort 后删除该临时 session，以及本次 probe 在初始语义为空的专属 sessions
   根内新建的受限 `skills-prompts` cache；不得以普通测试授权代替本次 live 授权。

## 命令

先设置三个显式路径与 live gate；下面的值必须由操作者替换，不能复制为默认目标：

```sh
export PANEL_RUNTIME_ACCEPTANCE_CONFIG_PATH=/explicit/openclaw.json
export PANEL_RUNTIME_ACCEPTANCE_SESSIONS_ROOT=/explicit/agents/panel-example-runtime/sessions
export PANEL_RUNTIME_ACCEPTANCE_WORKSPACE_ROOT=/explicit/workspace
export PANEL_ALLOW_RUNTIME_ACCEPTANCE=1

npm run --silent test:runtime-acceptance -- \
  --agent panel-example-runtime \
  --expected-version 2026.6.11 \
  --scenario memory-search-canary-v1 \
  --max-runs 1 \
  --cleanup delete-created-session-v1 \
  --confirm runtime-acceptance:panel-example-runtime:2026.6.11
```

`npm run test:runtime-acceptance` 本身不设置 gate。不要在 CI、普通单测或未经逐目标授权时运行。

## 通过条件与停止条件

探针在 send 前重新确认 config/root/workspace identity；要求 configured catalog 至少包含
`browser`、`canvas`、`memory_search`，同时该临时 session 的 effective tools 必须精确为
`["memory_search"]`。prompt 只给 QUERY marker；通过必须在 pinned OpenClaw `2026.6.11` 的 native
transcript 中看到唯一的 assistant `toolCall(arguments)`、其直接后继的 top-level
`role: "toolResult"`（同一 `toolCallId`、`toolName: "memory_search"`、`isError: false`），以及该
result 的唯一直接 assistant 后继。provider wire-format `tool_use`/`tool_result` wrapper、query 回显或
“no results” 都不能假通过。模型最终输出只允许固定 JSON：五个
bootstrap 文档名称与经过严格字符白名单的非空 skill 名称；正文、路径和 tool result 不进入报告。

任何 config/root/workspace/canary 变化、额外工具、缺少 bootstrap/skill、run ID 不一致、终态未知、
workspace 改写或清理失败都立即失败。send 后终态未知只以该次 requested run ID 尝试一次 abort；
abort 未确认时不删除 runtime artifact，也不重试 send。清理前验证 pinned sessions-root dev/inode，
先删除新建 session 的 allowlisted artifact。若 OpenClaw 在这个运行前语义为空的专属 root 新建
`skills-prompts` cache，探针还只接受 `skills-prompts/sha256/<2 hex>/<64 hex>.txt` 的精确结构、
最多 8 个 prefix/8 个文件/4 MiB；它不读取 cache 正文，并在每个 unlink/rmdir 前后复核 owner、
私有权限、link count、dev/inode 与完整祖先目录 identity。任何额外名称、容量超限、symlink、
hardlink 或 identity 变化都会保留 cache 并以 cleanup failure 停止，绝不扩大删除范围。

成功 stdout 仅含固定 shape、最小目标 agent ID、版本、布尔值和 skill 数量；不含 skill 名、config/workspace/
sessions path、凭据、hash、正文、session/run/tool-call ID。失败 stderr 只含固定 error code 与 cleanup code。

实际执行后，把日期、ark-panel canonical commit、OpenClaw 版本、最小目标 ID、完整命令形状和脱敏
JSON 结论新增到 current acceptance matrix；不要改写旧日期 evidence。一个 runtime 的通过不能外推到另一个。
