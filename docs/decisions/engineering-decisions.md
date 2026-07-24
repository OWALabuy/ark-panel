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

## 版本控制与升级维护（2026-07-12）

面板核心数据（transcript JSONL、metadata、index）是自主的、可迁移的，不绑定 OpenClaw。但 2a′ 混合架构对 OpenClaw 保留了一层**软耦合**：更换或升级 OpenClaw 时，这层是唯一需要重新验证/适配的面。集中记录，避免升级时到处找。

### 软耦合面（升级后逐项复核）
1. **版本门禁**：第一版固定 `2026.6.11`。启动推理前核对 CLI/gateway 版本；不匹配返回 `OPENCLAW_VERSION_UNSUPPORTED`，拒绝推理与清理。升级 = 抬高这个 pin，且必须在抬高前跑完下面的复核。
2. **transcript 格式**：会话头 `version:3`、`id`/`parentId` 树、content block 类型（text / tool_use / tool_result / thinking / model_change / thinking_level_change / custom）。schema 变了，解析器与 fork 回溯都要改。
3. **推理桥接 RPC 与流程**：`sessions.create` → 覆盖 transcript → `sessions.send` → 读新增 entry → `sessions.delete` + 受限清理。RPC 名称、参数、一次性 session 行为都可能随版本变。
4. **握手与鉴权**：operator 角色 + `gateway.auth.token`、跳过设备签名的分支（`roleCanSkipDeviceIdentity`）。
5. **清理 artifact 类型**：`.jsonl.deleted.*`、`.trajectory.jsonl`、`.trajectory-path.json`。版本若新增/改名 artifact 类型，清理 allowlist 要同步扩充，否则残留累积。
6. **记忆机制假设**：共享 workspace 的记忆文件与 bootstrap 注入、内置 engine 对 `MEMORY.md` / `memory/**/*.md` 的索引、文件 watcher、dreaming/promote 和压缩前 flush 的行为（见 `panel-memory.md`）。`scratch` 与 `eligible` 都读取既有记忆；面板只为 eligible 维护每会话一份独立的滚动短期文件。普通 session 缺少按路径只读和动态工具 deny 的限制，以及临时 runtime transcript 是否可能被 dreaming 摄取，升级或启用 dreaming 前都须重验。
7. **打包源码路径**：`~/.nvm/.../node_modules/openclaw/dist/*.js` 的文件名带内容哈希后缀，升级必变；任何靠读 dist 得出的结论都要重查，不能假设文件名不变。

### 升级流程（不在真实 agent 上首验）
1. 先在隔离的 `paneltest`（无渠道绑定）上装新版本，跑推理桥接冒烟 + 上述 2–6 项复核。
2. 复核通过后再抬高版本 pin，并更新本文与 `architecture.md §四` 里标注的版本号。
3. 复核未过时，面板对新版本继续走版本门禁拒绝推理，直到适配完成；期间只读浏览仍可用（只读不依赖桥接）。
4. OpenClaw 升级与面板自身发布相互独立：面板可在不升 OpenClaw 时发版；升 OpenClaw 必须过版本门禁。
5. 面板自身依赖（npm 包）用锁文件固定版本；升级依赖后跑 `npm test` 与部署 smoke 再发布。

### 面板自身版本
- 面板遵循语义化版本；破坏 transcript / metadata / index 存储格式的改动记为不兼容变更，并附带迁移步骤（存储是权威数据，格式变更必须可迁移、可回滚）。
- 支持的 OpenClaw 版本范围在 README 与本文各记一处，发布说明里点明。

## 长上下文保护（第一版）

推理适配层在任何 gateway `sessions.create` / `sessions.send` 之前执行上下文预算检查。接口输入是面板将物化的完整 `TranscriptDocument` 与本轮用户消息，输出包括 `estimatedTokens`、`budgetTokens`、`remainingTokens` 和估算方法版本。

当前采用 `utf8-bytes-upper-bound-v3`：先按 OpenClaw 2026.6.11 `buildSessionContext` 语义投影当前分支；若存在压缩，只计算最新摘要、`firstKeptEntryId` 起的 inclusive kept tail 与压缩后消息，再把投影和本轮消息的 UTF-8 字节数作为 token 上界并增加固定结构开销。它不是精确 tokenizer，会有意高估普通文本；默认历史预算为 100000 tokens，刻意为 gateway 注入的系统提示、记忆、工具 schema 和回复输出留余量。预算通过 `PANEL_CONTEXT_HISTORY_BUDGET_TOKENS` 配置。

超过预算时返回稳定错误 `CONTEXT_BUDGET_EXCEEDED`，不调用 gateway、不写入本轮 user entry，并提供“压缩上下文”操作。70% 起警告、90% 起危险提示和明确操作；首版只手动压缩，不静默自动执行。压缩记录是完整 transcript 中的边界，fork 在边界前不继承摘要、在边界及之后继承摘要。

## 备份、恢复与迁移

备份只包含面板权威数据与配置模板，不包含 gateway token 和临时 runtime artifact。清单记录文件大小、SHA-256 与空目录，并设清单大小、条目数、单文件和总字节资源上限；备份与恢复使用目标名协作锁。restore 在 verify 后的实际复制阶段再次逐文件核对哈希，并复核目标父目录身份，目标目录必须不存在；文件权限为 `0600`、目录为 `0700`。远端备份必须使用 git-crypt 或等价加密。恢复验收为：复制数据目录后全量重建索引，所有 recordId、fork 来源和 transcript 内容保持一致。迁移到新机器时允许源绝对路径变化，因此稳定 ID 不依赖绝对路径。
