# 会话面板工程决定

更新日期：2026-07-11

## 技术栈

- Node.js 22，npm，TypeScript（严格模式）。
- 服务端使用 Node 自带 HTTP 能力，第一阶段不引入 Web 框架；接口增多后再评估 Fastify。这样核心存储代码不依赖 Web 框架。
- 前端预定 React + Vite；第一阶段先提供能启动和做健康检查的服务端骨架，避免在数据接口未稳定时堆积界面代码。
- 测试使用 Node 自带的 `node:test`，编译后运行，不引入测试框架。

## 目录

正式工程位于仓库根目录：

- `src/domain/`：transcript、fork 和标识等纯逻辑。
- `src/storage/`：扫描、导入、索引和原子文件操作。
- `src/gateway/`：OpenClaw 版本检查、推理桥接与受限清理。
- `src/server/`：HTTP API 和 SSE。
- `test/fixtures/`：完全虚构、脱敏的测试数据。

运行数据不放进源码目录。`PANEL_DATA_DIR` 指定面板数据根目录；没有设置时拒绝启动正式读写服务。agent 和对应 runtime agent 通过服务端配置 allowlist，浏览器不能提交文件路径。

## HTTP 与 SSE

API 统一位于 `/api/v1`。成功响应是 `{ "data": ... }`；失败响应是 `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`。错误码使用稳定的大写英文标识，用户可见说明用中文。

生成接口使用 SSE，事件固定为 `run.started`、`run.delta`、`run.completed`、`run.failed`、`run.aborted`。每个事件的 `data` 是 JSON，并带 `runId`。SSE 只负责显示；权威 transcript 只在完整 run 校验通过后提交。

服务只监听 `127.0.0.1`。修改请求必须通过严格同源检查；实现登录后再加双重提交 CSRF token。日志不记录消息正文、提示词、token 或完整路径。

## 存储

- panel 会话的 transcript 与 metadata 是权威数据；`index.json` 只是可删除并重建的缓存。
- active 会话只读源文件；reset 会话导入为不可变快照；panel 会话只写面板数据目录。
- active/reset 的 `recordId` 由 agent、类型及稳定来源标识计算；panel 的 UUID 写入 metadata。重建索引不会改变 ID。
- metadata 记录 fork 来源，不能只放在索引里。
- 完整 run 使用同目录临时文件、`fsync`、原子改名提交；索引也采用同样方式。不会把多行 append 当作事务。
- 读写时拒绝符号链接，规范化路径后必须仍位于配置的根目录。

## OpenClaw 兼容与推理 runtime

第一版只支持 OpenClaw `2026.6.11`。启动推理功能前核对 CLI/gateway 版本；不匹配时返回 `OPENCLAW_VERSION_UNSUPPORTED`，不执行清理或推理。

每个真实 agent 对应一个不绑定渠道的专用 runtime agent。runtime 与目标 agent共用 workspace，以获得相同的系统文件、记忆和工具配置；两者的 sessions 目录隔离。每次推理创建一个临时 session，不能复用。

清理顺序固定为：先调用官方 `sessions.delete` 注销，再删除 runtime agent 专用 sessions 根目录中、与本次已验证 sessionId 严格匹配的已知 artifact。清理函数只接受服务端刚创建并登记的 UUID；只允许 `.jsonl.deleted.*`、`.trajectory.jsonl`、`.trajectory-path.json` 等经过当前版本验证的类型；拒绝符号链接、目录越界和未知文件。真实 agent 的 sessions 根目录永远不进入清理 allowlist。

## 长上下文保护（第一版）

推理适配层在任何 gateway `sessions.create` / `sessions.send` 之前执行上下文预算检查。接口输入是面板将物化的完整 `TranscriptDocument` 与本轮用户消息，输出包括 `estimatedTokens`、`budgetTokens`、`remainingTokens` 和估算方法版本。

第一版采用 `utf8-bytes-upper-bound-v2`：把序列化历史和本轮消息的 UTF-8 字节数作为 token 数上界，并为 transcript entry 加固定结构开销。它不是精确 tokenizer，会有意高估普通文本；默认历史预算为 100000 tokens，刻意为 gateway 注入的系统提示、记忆、工具 schema 和回复输出保留余量。预算通过 `PANEL_CONTEXT_HISTORY_BUDGET_TOKENS` 配置。

超过预算时返回稳定错误 `CONTEXT_BUDGET_EXCEEDED`，不调用 gateway、不写入本轮 user entry，并向用户建议从较早位置 fork。第一版明确不做静默截断，也不做伪自动摘要。精确的模型 tokenizer、压缩 checkpoint、摘要生成与 fork 穿越摘要边界仍属于后续上下文管理策略。

## 备份、恢复与迁移

备份只包含面板权威数据与配置模板，不包含 gateway token 和临时 runtime artifact。清单记录文件大小、SHA-256 与空目录，并设清单大小、条目数、单文件和总字节资源上限；备份与恢复使用目标名协作锁。restore 在 verify 后的实际复制阶段再次逐文件核对哈希，并复核目标父目录身份，目标目录必须不存在；文件权限为 `0600`、目录为 `0700`。远端备份必须使用 git-crypt 或等价加密。恢复验收为：复制数据目录后全量重建索引，所有 recordId、fork 来源和 transcript 内容保持一致。迁移到新机器时允许源绝对路径变化，因此稳定 ID 不依赖绝对路径。
