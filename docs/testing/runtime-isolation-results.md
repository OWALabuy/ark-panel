# `panel-claude-runtime` 隔离生成验收

验收日期：2026-07-11
OpenClaw：2026.6.11（e085fa1）
目标 runtime：`panel-claude-runtime`

## 前置条件

- `openclaw agents list --json` 显示 runtime workspace 为真实 `claude` workspace、模型一致、bindings 为 0。
- `openclaw agents bindings --agent panel-claude-runtime --json` 返回空数组。
- runtime sessions 根为 `~/.openclaw/agents/panel-claude-runtime/sessions`，与真实只读根不重叠；验收前只有内容为 `{}` 的 `sessions.json`。
- 没有调用真实 `claude` 的 session key，没有向 IM 发送消息，没有触发工具、memory search、browser 或 shell。

## 通过项

新增了可重复执行的显式验收脚本 `src/server/panel-claude-runtime-smoke.ts`，仅在设置 `PANEL_ALLOW_CLAUDE_RUNTIME_ACCEPTANCE=1` 时运行。它经完整本地 HTTP 登录、CSRF、新建 panel 会话和 bridge 调用专用 runtime，要求模型只返回一次随机固定短语。

连续三次受控调用均完成：

- HTTP SSE 出现 `run.completed`；
- panel transcript 存在并包含固定短语；
- transcript 中没有 tool call / tool result；
- 完整 run 已提交到临时 `PANEL_DATA_DIR`；
- 官方注销后，受限清理移除了 transcript 归档和 trajectory 等 session artifacts；
- runtime 的 `sessions.json` 恢复为 `{}`，没有登记 session；
- 临时 `PANEL_DATA_DIR` 均已删除；
- OpenClaw 主配置哈希、runtime binding 哈希、真实 `claude` workspace 元数据哈希在核验窗口内保持不变。

OpenClaw 在首次运行 runtime 时会在其 sessions 根生成 `skills-prompts/sha256/...`。这是共享 workspace 的技能提示缓存，不以 sessionId 命名，也不是会话 artifact。正式 session 清理器仍坚持只删除已验证 sessionId 的已知文件；验收脚本单独识别并在结束时移除本次生成的缓存，使 runtime 根恢复到验收前状态。

## 未能严格证明的一项

第三次核验窗口内，真实 `claude` 的一个既有活 session 正在被外部并发写入：该既有 session 的 JSONL、trajectory、trajectory pointer 和 `sessions.json` 元数据时间/大小发生变化。没有读取其正文。因而“真实 claude sessions 整目录元数据哈希前后完全相同”这一断言未通过。

变化的文件属于同一个验收前已经存在的真实活 session，而不是本次 runtime 创建的一次性 session；runtime 自己的 session 已注销并清净删除。当前证据更符合真实渠道/其它客户端并发活动，未发现 runtime 串写真实 sessions 根的证据。但在活 gateway 持续服务时，整目录哈希无法把外部并发写入和串写严格区分，因此按安全约束停止继续生成，不把该项记为通过。

若要取得严格证明，应选一个确认真实 `claude` 暂无活动的短窗口，保存逐文件元数据清单并在一次调用后比较；不需要停止或重启 gateway，也不需要读取会话正文。
