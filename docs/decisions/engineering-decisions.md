# 会话面板工程决定

更新日期：2026-08-12

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

## HTTPS 反向代理信任边界（2026-08-13）

- 监听地址、浏览器可见的 canonical origin 与可接受的 HTTP `Host` 是三个独立概念。进程仍固定监听 `127.0.0.1`；`PANEL_PUBLIC_ORIGIN` 只增加一个显式外部 origin，其规范化 Host 自动加入信任列表。
- 默认信任仅为实际监听端口上的 `127.0.0.1` 与 `localhost` HTTP。`PANEL_TRUSTED_HOSTS` 只允许补充有限数量的精确 Host，不支持 wildcard，也不能用重复值表达优先级。
- origin/Host 在启动时和请求时使用同一规范化规则。只接受 HTTP(S)、ASCII DNS/规范 IP 与精确端口；拒绝 userinfo、路径、query、fragment、IDN/punycode、替代数字 IP 和非规范 IPv6 表示。HTTPS 外部 origin 必须启用 Secure cookie。
- 请求只以实际 `Host` 和浏览器 `Origin` 为依据。服务不读取 `Forwarded` 或任何 `X-Forwarded-*`，也不会从请求动态学习 origin；未来若支持这些头，必须另立 trusted-proxy 身份边界。
- Host 校验覆盖健康检查、静态资源、API 与 SSE，失败继续使用 `421 HOST_REJECTED`。登录和所有 mutation 继续要求显式匹配的 Origin；缺失/`null`/跨源保持拒绝，mutation 还必须通过登录态与 CSRF token，错误码保持既有 `ORIGIN_REJECTED` / `CSRF_REJECTED`。
- 配置校验错误和启动日志只说明变量或监听地址，不回显外部部署名称、请求头、凭据或路径。

## 存储

- panel 会话的 transcript 与 metadata 是权威数据；会话读取索引只存在于进程内，可随时清空并从权威文件重建。遗留 `index.json` 不参与读取。
- active/reset 会话保持 OpenClaw 源文件只读；panel 会话只写面板数据目录。索引可缓存已验证 document，但不复制出另一份权威 transcript。
- active/reset 的 `recordId` 由 agent、类型及稳定来源标识计算；panel 的 UUID 写入 metadata。重建索引不会改变 ID。
- metadata 记录 fork 来源，不能只放在索引里。
- 新建 panel 会话时，`metadata.json`、`transcript.jsonl` 与可选 `attachments.json` 先在同父目录的保留 staging 目录中完整写入并逐层 `fsync`，只用单次目录 rename 发布为可见记录。fork 在同一附件存储互斥区内完成源引用/manifest/blob 预检和目标发布，只复制目标 transcript 实际引用的 owner 记录，不修改源索引或内容寻址文件。staging 和单条残缺/损坏记录只作脱敏诊断与隔离，不自动删除，也不得影响其他健康会话或附件 GC。
- 完整 run 使用同目录临时文件、`fsync`、原子改名提交；不会把多行 append 当作事务。进程内读取索引没有持久写入步骤。
- 读写时拒绝符号链接，规范化路径后必须仍位于配置的根目录。

## OpenClaw 兼容与推理 runtime

第一版只支持 OpenClaw `2026.6.11`。启动推理功能前核对 CLI/gateway 版本；不匹配时返回 `OPENCLAW_VERSION_UNSUPPORTED`，不执行清理或推理。

每个真实 agent 对应一个不绑定渠道的专用 runtime agent。runtime 与目标 agent共用 workspace，以获得相同的系统文件、记忆和工具配置；两者的 sessions 目录隔离。每次推理创建一个临时 session，不能复用。

清理顺序固定为：先调用官方 `sessions.delete` 注销，再删除 runtime agent 专用 sessions 根目录中、与本次已验证 sessionId 严格匹配的已知 artifact。清理函数只接受服务端刚创建并登记的 UUID；只允许 `.jsonl.deleted.*`、`.trajectory.jsonl`、`.trajectory-path.json` 等经过当前版本验证的类型；拒绝符号链接、目录越界和未知文件。真实 agent 的 sessions 根目录永远不进入清理 allowlist。

## Gateway WebSocket 权限范围与凭据生命周期（2026-08-12）

**决定：接受一条带管理权限的本机控制连接。** 面板服务端复用一条持久 Gateway WebSocket 承担观察、生成控制、结构化命令和临时 session 生命周期；本批不拆成多条连接或多份凭据。该决定只适用于版本门禁固定的 OpenClaw `2026.6.11`。

握手身份固定为 `client.id=gateway-client`、`client.mode=backend`、`role=operator`，并且请求的 scope 集合必须恰好是 `operator.read`、`operator.write`、`operator.admin`。Gateway `hello.auth.scopes` 也必须与该集合完全相同：缺少任一项或返回额外项都拒绝连接，不尝试动态加权、降权或扩大权限。每次 socket 都有独立 generation；只有当前 source 在该 generation 完成精确 hello 和订阅后才能投递事件，旧 socket 的迟到 open/message/challenge/hello/error/close/send callback 全部忽略。当前 socket 发送失败或 ready 状态失效则清空该 generation 的授权与 pending、关闭 socket 并重新握手。握手失败和 RPC 拒绝只向面板上层返回稳定、归一化、脱敏的错误；token、password、原始上游 payload、消息正文和 prompt 不得进入错误或日志。

当前生产调用面固定为：

| scope | 面板使用的 RPC / 订阅 | 用途 |
|---|---|---|
| `operator.read` | `status`、`commands.list`、`tools.catalog`、`tools.effective`、`sessions.list`、`sessions.subscribe`、`sessions.messages.subscribe` / `sessions.messages.unsubscribe`、`artifacts.list`、`artifacts.download` | 状态与目录读取、session/消息观察、当前 run 产物收集 |
| `operator.write` | `sessions.create`、`sessions.send`、`sessions.abort` | 创建一次性 runtime session、发送本轮消息或附件、停止当前 run |
| `operator.admin` | `sessions.patch`、`sessions.delete`、`sessions.compact` | 应用临时 session override、注销临时 session、执行持久压缩流程 |

该矩阵依据 OpenClaw `2026.6.11` 官方发行包内的 `docs/gateway/operator-scopes.md`、`docs/gateway/protocol.md` 与 core method descriptors 核对；admin 的蕴含关系只用于理解上游授权，不能让面板接受缩写后的 `hello` 集合。升级时必须针对新发行包重新核对，不能沿用内容哈希文件名或当前分类。

scope 集合只描述 Gateway 连接具备的上游能力，不替代面板自己的 typed API、登录、CSRF 和 default-deny allowlist。尤其是持有 `operator.admin` 会令内部命令满足 owner 判定，因此普通消息路径继续拒绝所有 `/` 文本，D 类管理命令也不因连接有 admin scope 而获得面板入口。

这是 trusted-local、single-operator 部署中的纵深 guardrail，不是强多租户隔离边界。共享 token/password 按 owner 级 secret 管理，只能存在于服务端环境或 OpenClaw 配置中，不下发浏览器；Gateway 默认只经 loopback 访问，显式远程配置也只能指向同一所有者控制的可信私网，不得直接暴露到公网。上游即使允许 direct-loopback `auth.mode=none`，面板也不以无 secret 身份建立这条 admin 连接：生产必须解析出至少一个非空 token/password，显式空白环境覆盖项不得回落到磁盘配置。远程端点不继承 direct-loopback self-pairing，必须另行完成上游配对与隔离验收。当前凭据已经服务于同一 owner 连接，scope 是握手契约而非本次需要迁移的面板数据，因此本批无需重新签发凭据。

凭据轮换必须把 Gateway 与面板视为同一个发布单元：先准备新 secret，同步更新两端，再重启 Gateway 与面板并确认精确 scope 握手；不得让新旧 secret 长期并存。若轮换需回滚，则在两端恢复受保护的上一份 secret 并再次同步重启。部署本批代码只需正常重启面板以启用握手强制；不改存储格式、不改 OpenClaw pin。若精确 scope 校验与既有部署不兼容，回滚到上一版面板即可，凭据与 OpenClaw 配置无需转换，同时保留版本门禁，不能以接受未知或额外 scope 作为临时绕过。

`PANEL_OPENCLAW_STREAMING=0` 只关闭临时文本/工具预览；同一控制 WebSocket 及上述三个 scope 仍用于生成、结构化命令、附件和 admin 生命周期。预览订阅失败而控制连接仍可用时只降级预览；生产无法解析固定凭据时不创建连接，并向 Gateway 调用面注入只返回 `GATEWAY_TRANSPORT_UNAVAILABLE` 的拒绝 transport。凭据缺失、控制连接不可用、scope 不匹配或 RPC 被拒绝时，相关 Gateway 操作失败关闭，本地权威会话的只读浏览仍可用，不能回落为逐次 Gateway CLI RPC。

备选方案——把观察、写入与管理拆成独立连接/身份——需要新增凭据模型、部署迁移与回滚步骤，并对固定版本重新做隔离 runtime 验收；它是独立工作项，不在本批静默引入。本决定没有宣称完成新的真实 runtime 验收，真实环境复验仍按版本门禁和专门验收流程执行。

## 版本控制与升级维护（2026-07-12）

面板核心数据（transcript JSONL、metadata）是自主的、可迁移的，不绑定 OpenClaw；读取索引由这些数据重建。但 2a′ 混合架构对 OpenClaw 保留了一层**软耦合**：更换或升级 OpenClaw 时，这层是唯一需要重新验证/适配的面。集中记录，避免升级时到处找。

### 软耦合面（升级后逐项复核）
1. **版本门禁**：第一版固定 `2026.6.11`。启动推理前核对 CLI/gateway 版本；不匹配返回 `OPENCLAW_VERSION_UNSUPPORTED`，拒绝推理与清理。升级 = 抬高这个 pin，且必须在抬高前跑完下面的复核。
2. **transcript 格式**：会话头 `version:3`、`id`/`parentId` 树、content block 类型（text / tool_use / tool_result / thinking / model_change / thinking_level_change / custom）。schema 变了，解析器与 fork 回溯都要改。
3. **推理桥接 RPC 与流程**：`sessions.create` → 覆盖 transcript → `sessions.send` → 读新增 entry → `sessions.delete` + 受限清理。RPC 名称、参数、一次性 session 行为都可能随版本变。
4. **握手、鉴权与 scope 矩阵**：`gateway-client/backend` + operator 角色 + 共享 token/password、direct-loopback backend self-pairing 分支、请求和 `hello` 精确匹配 `operator.read` / `operator.write` / `operator.admin`，以及上表每个 RPC 的 scope 归属。
5. **清理 artifact 类型**：`.jsonl.deleted.*`、`.trajectory.jsonl`、`.trajectory-path.json`。版本若新增/改名 artifact 类型，清理 allowlist 要同步扩充，否则残留累积。
6. **记忆机制假设**：共享 workspace 的记忆文件与 bootstrap 注入、内置 engine 对 `MEMORY.md` / `memory/**/*.md` 的索引、文件 watcher、dreaming/promote 和压缩前 flush 的行为（见 `panel-memory.md`）。`scratch` 与 `eligible` 都读取既有记忆；面板只为 eligible 维护每会话一份独立的滚动短期文件。普通 session 缺少按路径只读和动态工具 deny 的限制，以及临时 runtime transcript 是否可能被 dreaming 摄取，升级或启用 dreaming 前都须重验。
7. **打包源码路径**：`~/.nvm/.../node_modules/openclaw/dist/*.js` 的文件名带内容哈希后缀，升级必变；任何靠读 dist 得出的结论都要重查，不能假设文件名不变。

### 升级流程（不在真实 agent 上首验）
1. 先在隔离的 `paneltest`（无渠道绑定）上装新版本，跑推理桥接冒烟 + 上述 2–7 项复核；握手 scope 与 RPC 权限矩阵必须逐项重验。
2. 复核通过后再抬高版本 pin，并更新本文与 `architecture.md §四` 里标注的版本号。
3. 复核未过时，面板对新版本继续走版本门禁拒绝推理，直到适配完成；期间只读浏览仍可用（只读不依赖桥接）。
4. OpenClaw 升级与面板自身发布相互独立：面板可在不升 OpenClaw 时发版；升 OpenClaw 必须过版本门禁。
5. 面板自身依赖（npm 包）用锁文件固定版本；升级依赖后跑 `npm test` 与部署 smoke 再发布。

### 面板自身版本
- 面板遵循语义化版本；破坏 transcript / metadata 存储格式的改动记为不兼容变更，并附带迁移步骤（存储是权威数据，格式变更必须可迁移、可回滚）。进程内读取索引没有迁移格式。
- 支持的 OpenClaw 版本范围在 README 与本文各记一处，发布说明里点明。

## 长上下文保护（第一版）

推理适配层在任何 gateway `sessions.create` / `sessions.send` 之前执行上下文预算检查。接口输入是面板将物化的完整 `TranscriptDocument` 与本轮用户消息，输出包括 `estimatedTokens`、`budgetTokens`、`remainingTokens` 和估算方法版本。

当前采用 `utf8-bytes-upper-bound-v3`：先按 OpenClaw 2026.6.11 `buildSessionContext` 语义投影当前分支；若存在压缩，只计算最新摘要、`firstKeptEntryId` 起的 inclusive kept tail 与压缩后消息，再把投影和本轮消息的 UTF-8 字节数作为 token 上界并增加固定结构开销。它不是精确 tokenizer，会有意高估普通文本；默认历史预算为 100000 tokens，刻意为 gateway 注入的系统提示、记忆、工具 schema 和回复输出留余量。预算通过 `PANEL_CONTEXT_HISTORY_BUDGET_TOKENS` 配置。

超过预算时返回稳定错误 `CONTEXT_BUDGET_EXCEEDED`，不调用 gateway、不写入本轮 user entry，并提供“压缩上下文”操作。该保守上界是内部安全判定，不作为界面的当前 token 用量。界面仅采用 OpenClaw `sessions.list` 标记为 fresh 的 `totalTokens/contextTokens`；缺失时显示未知。首版只手动压缩，不静默自动执行。压缩记录是完整 transcript 中的边界，fork 在边界前不继承摘要、在边界及之后继承摘要。

OpenClaw 返回 `compacted: true` 只代表上游执行了压缩流程，不足以证明面板的有效上下文已经减少。面板在采纳候选 compaction 前，必须用生成保护所用的 `ConservativeContextBudget` 分别估算当前权威 document 与候选 document；只有候选 `estimatedTokens` 严格更小时才原子提交。若完整历史仍从 `firstKeptEntryId` 保留、摘要只被额外加入，或任何其他候选未产生有效减少，返回 `compacted: false`、reason `NO_EFFECTIVE_REDUCTION`，不改变 transcript 与 revision。面板不得自行改写上游边界来丢弃未被可靠摘要的消息。

## 备份、恢复与迁移

备份只包含面板权威数据与配置模板，不包含 gateway token 和临时 runtime artifact。清单记录文件大小、SHA-256 与空目录，并设清单大小、条目数、单文件和总字节资源上限；备份与恢复使用目标名协作锁。restore 在 verify 后的实际复制阶段再次逐文件核对哈希，并复核目标父目录身份，目标目录必须不存在；文件权限为 `0600`、目录为 `0700`。远端备份必须使用 git-crypt 或等价加密。恢复验收为：复制数据目录后全量重建索引，所有 recordId、fork 来源和 transcript 内容保持一致。迁移到新机器时允许源绝对路径变化，因此稳定 ID 不依赖绝对路径。
