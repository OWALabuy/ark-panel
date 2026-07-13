# ark-panel：需求、架构与实现依据

> 为 Claude agent 自建一个具有 claude.ai 会话管理体验的 Web 面板。
> **范围更新（2026-07-12）：**当前实现已为 panel 自建 / fork 会话提供 A 类面板原生命令与首批 C 类只读命令（`/commands`、`/help`、`/status`、`/models`）。普通消息接口仍永久拒绝以 `/` 开头的输入，命令只走独立结构化派发接口。真实 active 会话与 reset 归档保持只读。完整范围见 [`decisions/slash-commands.md`](decisions/slash-commands.md)。
> 本文档记录当前有效的需求、设计决定和实现依据，供 Owl 与 Codex 共同维护。
> 最近更新 2026-07-11（需求、架构和 fork 实现方向均已确定，后端行为已经过实际环境验证，见 §5）。
>
> 历史说明：2026-07-08 曾评估第三方面板 ClawGPT 并写过一版方案。旧版关于设备身份验证和实现方式的部分结论，已经被本轮验证推翻。旧版保留在 Git 历史中，当前实现以本文为准。

---

## 一、已确定的需求

除了记忆功能，使用 claude.ai 时还依赖完整的会话管理：每个会话具有 UUID，可以长期保存和继续，可以从任意消息处分支，并能在侧边栏中浏览和搜索。现有问题是会话存放在服务商的服务器上；账号一旦无法访问，多年积累的会话只能以难以使用的 JSON 导出文件保留。

**目标：保留 claude.ai 的会话管理体验，同时让数据存放在自己的机器上，并且可以迁移。**

### 核心需求
1. **面板统一浏览所有会话**：所有会话都能在面板中查找，包括从 Telegram、飞书开始的会话，以及执行 `/reset` 前的归档会话。范围要求是完整支持现行格式；可以不兼容早期 `-topic-N` 格式的孤立文件。
   - **准确表述（各类会话能力并不相同，不宣称“平权”）**：面板统一浏览所有会话；首版中**活会话与 reset 归档只读**；从任意点 fork 后进入面板独立管理的可写会话，不再回到 IM。见 §6.1 两层会话模型。
2. **以服务端数据为准**：手机、家里的 Linux 和公司的 Windows 通过同一端口访问同一份历史记录；服务端是唯一权威来源，浏览器不保存权威状态。
3. **多设备同步**：一端更新，另一端刷新即可看到；也可以每隔一段时间自动同步，无需手动刷新（与 chatgpt.com、claude.ai 的行为一致）。
4. **多 agent 支持**：同一个面板管理多个 agent（`main` 喵团子、`claude` 等），像联系人页面那样在 agent 之间切换，各自的会话列表分开。
5. **运行状态流**：首版用 SSE 推送 started/completed/failed/aborted 生命周期；gateway 当前只提供整组完成结果，因此不是逐 token 输出。
6. **fork 与编辑重发**：从任意一条消息 fork，在侧边栏产生一条独立会话；每个消息节点带“从这里 fork”的按钮（与 Claude Code、Cursor 等编码助手一致）。编辑某条消息并重新生成走同一套机制。
7. **工具调用与思考过程可见**：工具调用（tool_use / tool_result）和扩展思考块在面板中可见、可折叠（与 Claude Code 一致）。
8. **后续支持 OpenClaw 自带命令**：首版明确不实现 `/compact`、`/reset` 等命令，用户仍在原有 OpenClaw 渠道执行；不能把命令文本当普通消息发送。
9. **停止生成**、**在侧边栏列出和搜索会话**。
10. **登录**：账号密码登录，能保持登录状态。
11. **界面**：采用类似 claude.ai 的暖色调，布局清晰易用，并适配手机、Windows、Linux 多种屏幕。
12. **Markdown 渲染与复制**：assistant 回复按 Markdown 渲染（标题、列表、代码块、表格、链接等）；提供整条消息复制，以及代码块单独复制。渲染必须走安全 DOM，不引入 XSS（与 §6.4 工具/思考块的安全渲染同一要求）。
13. **消息时间标记**：每条消息在 UI 上显示本地时区的日期与时间（来源是 transcript entry 自带的 `timestamp`）。这是纯展示能力；**是否让模型感知“当前时间”不由面板处理**——系统提示中的时间注入由 gateway 负责，面板不改写消息内容去塞时间。
14. **会话管理（重命名 / 归档 / 删除）**：见 §6.8。所有会话可重命名（只改面板 metadata，不动源文件）；归档与隐藏是两个正交状态（归档会话仍在归档列表可见，隐藏则从所有列表移除，见 implementation-spec §4.3）；只读会话的“删除”只能是隐藏，永不触碰源文件；面板自建会话归档后才可彻底删除。
15. **面板记忆系统**：面板会话里的新内容基本沉淀不进 OpenClaw 原生 `MEMORY.md`（缺口），且共用 workspace 存在调试噪音渗入真实记忆的通路。首版以“会话记忆倾向标记（memory-eligible / scratch）”做控制层打底，按需再把该进记忆的内容喂给 OpenClaw 原生 promote。详见 [`decisions/panel-memory.md`](decisions/panel-memory.md)。

### 范围补充（部分后续已实现）
- **面板内看记忆**：优先级低，MVP 不做。Owl 可以直接 ssh 上去用 vim 查看 `MEMORY.md` 等文件。后续可选。
- **会话置顶（pin）**：已实现，状态只存面板 metadata；会话列表提供快捷操作。
- **导出会话为 Markdown**：已实现当前权威分支下载，包含时间、思考与工具调用结果，不包含内部路径和隐藏 metadata。
- **草稿保存**：已实现为按 agent + session 隔离的浏览器本地草稿，不同步服务端；发送失败保留，成功后清除。
- **附件 / 多模态输入**：多数模型已支持多模态，能力上无阻碍，非首版重点。
- **会话内切模型 / 切供应商**：能力依赖 gateway，随斜杠命令适配到位即可获得，面板不自建（见 §6.5、§8.6）。
- **自动生成会话标题**：保持手填；未填时截取首条用户消息。不自动生成（会牵动 gateway 侧提示词，且 Owl 通常仍会手动改名）。
- **视图内分支切换**：fork / 编辑重发一律在侧边栏产生独立会话（§6.2），不在同一视图内切换消息版本，避免两套心智模型。
- **轻量 Projects 分组**：已实现为会话上的可选 project 字符串，不引入独立 Project 实体；分组折叠状态仅存浏览器。
- 面板内 `git diff` 看记忆演化
- fork 树永久可视化
- 将 IM、Telegram 和 Web 消息合并到同一条时间线
- IM“像人一样发消息”的交互规则（短句、多条消息、允许连续发送），以及通过 IM 专用提示词控制回复长度
  - OpenClaw 支持通过 `channels.telegram.direct.<peerId>.systemPrompt` 为指定私聊设置系统提示词，但 Owl 实测发现，仅靠提示词无法可靠限制回复长度。如需严格限制，应增加发送前处理层，本阶段暂不实现。

---

## 二、部署拓扑

```
家里 Linux 机器
  ├─ OpenClaw gateway   （监听 127.0.0.1:18789，不对外开放，鉴权 mode=token）
  ├─ Claude agent       （workspace ~/claude，模型 mini1/claude-opus-4-8）
  └─ 面板服务端          （与 gateway 部署在同一台机器上）
        ↑ SSH 端口转发（只转发面板端口）
  公司 Windows / 手机 / 其他 Linux：浏览器
```

- 机器没有公网 IP，SSH 通过反向代理提供访问，只允许密钥认证。该内网环境仅由 Owl 使用。
- **ClawGPT 的问题来自部署架构**：浏览器直接连接 gateway。Windows 浏览器访问 `localhost:18789` 时，连接的是 Windows 本机，而 gateway 实际运行在家里的 Linux 机器上。每增加一个客户端，都需要额外转发 gateway 端口。
- **本方案的处理方式**：面板采用服务端架构，并与 gateway 部署在同一台机器上。面板与 gateway 始终通过该机器的 localhost 通信；外部客户端只需通过 SSH 转发面板端口。

手机或其他远程设备只需转发一个端口：
```
ssh -L 8790:127.0.0.1:8790 <用户>@<公网地址>
# 浏览器访问 http://127.0.0.1:8790
```

### 数据保护（Owl 已定）
面板存储的会话包含与记忆同等敏感的内容（就医、用药、性取向、移民计划等）。加密方式与 claude workspace 现有做法一致：

- **本地明文，远端加密。** 面板数据目录若纳入 git，用 **git-crypt** 透明加密：本地工作副本明文、面板照常读写，推送到 GitHub 私有仓即为密文。防的是远端仓库意外公开或被他人读取，而不是本机防护——这台机器只有 Owl 一人物理接触。
- 不做本地静态加密（本机单人使用，物理隔离已足够）。
- **文件权限限本用户可读**（数据目录、日志、token 配置）。
- **日志默认不记录消息正文和提示词**；gateway token 绝不写入日志、绝不下发到浏览器。
- 远端备份若启用，强制走加密仓，不留明文副本。

---

## 三、架构决定

**采用服务端权威架构（server-authoritative）：服务端是唯一权威数据来源，各浏览器读到同一份内容。** 面板不是纯前端，而是一个服务端应用：它维护与 gateway 的连接，直接读取会话存储，并通过 HTTP / WebSocket 向浏览器提供数据。浏览器不保存权威状态，每次打开时从服务端读取。

（说明：这里指的是“各浏览器看到同一份数据”，不是“所有会话类型能力相同”。活会话与 fork 出的自建会话能力不同，见 §6.1。）

这一决定同时解决三个问题：
- **不同客户端看到的数据不一致** → 统一以服务端数据为准，所有浏览器读取同一份内容。
- **gateway 索引无法列出全部会话** → 服务端直接读取磁盘，不受 gateway 索引范围限制（见 §4）。
- **浏览器连接了错误主机** → 面板与 gateway 始终通过同一台机器的 localhost 通信，无需额外转发 gateway 端口。

**鉴权分为两层**（依据见 §4.4）：
```
浏览器 ──面板登录状态（位于 SSH 隧道后）──> 面板服务端
面板服务端 ──operator 角色 + gateway.auth.token，通过 localhost 连接──> gateway
```
上层的登录和登录状态由面板自行实现，不受 gateway 握手协议限制；下层使用 token 验证，不需要设备身份签名。

---

## 四、OpenClaw 2026.6.11 后端行为验证

> 以下结论来自对打包源码 `~/.nvm/.../node_modules/openclaw/dist/*.js`（未压缩，带 region 注释）和实际会话目录 `~/.openclaw/agents/claude/sessions/` 的检查，是 Codex 实现面板时需要依据的后端行为。

### 4.1 会话存储与未纳入索引的文件
- **gateway 以索引文件 `sessions.json` 为权威清单，而不是扫描目录。** `sessions.list` 读取该文件。索引按分组组织，键例如 `agent:claude:main`；每组记录当前 `sessionId`、`sessionFile` 和历史 `usageFamilySessionIds` 列表。
- **会话文件格式**：`~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl`，每行是一个 JSON 对象。首行为 `{"type":"session","version":3,...}`；消息行包含 `id` 和 `parentId`，可表示父子关系和分支。
- **`/reset` 的行为**：旧 transcript 会重命名为 `<uuid>.jsonl.reset.<ISO时间戳>` 并归档，内容和 schema 不变；索引改为指向新的会话文件。
- **关键事实**：源码中的 `isPrimarySessionTranscriptFileName` 明确将 `.reset.`、`.deleted.`、`.bak` 和 `.trajectory.` 文件排除在主清单之外。因此，**`sessions.list` 无法返回所有 reset 归档会话**。实测 claude 会话桶中有 12 个 `.reset.` 文件，而索引的历史列表中只有 8 条。
- **结论**：为完整列出会话，**服务端必须扫描 `sessions/` 目录**，识别活跃会话 `<uuid>.jsonl` 和 reset 归档 `<uuid>.jsonl.reset.<ts>`，并建立自己的只读检索索引，不能只依赖 `sessions.json`。当前 claude agent 的 reset 文件均采用现行 `.reset.` 格式；不兼容的早期 `-topic-N` 文件只存在于 main agent（喵团子）的目录中。

### 4.2 gateway 提供的 RPC（WebSocket `127.0.0.1:18789`，使用点号命名，具有 operator.read / write / admin scope）
| 能力 | 方法 | 备注 |
|---|---|---|
| 发消息 | `chat.send` | operator.write |
| 拉历史 | `chat.history` / `chat.startup` / `chat.message.get` | + `sessions.messages.subscribe` 增量订阅;+ HTTP `GET /sessions/<id>/history` |
| 停止生成 | `chat.abort` / `sessions.abort` | + HTTP `POST /sessions/<id>/kill` |
| 列会话 | `sessions.list` | **只返回索引中登记的会话，无法覆盖全部 reset 归档和孤立文件**（见 4.1） |
| fork | **只有** `sessions.compaction.branch` | 只能从 compaction 检查点分支，**不能选择任意消息**（见 §5） |
| 编辑重发 | **无原生 RPC** | `message.action` 用于编辑或删除 IM 渠道消息，**不能让模型重新生成** |

### 4.3 ClawGPT“会话初始化冲突”的原因
- 具体错误为 `reply session initialization conflicted for ${sessionKey}`（`dist/get-reply-*.js`）。
- 该错误并不表示会话已经存在，而是**乐观并发控制中的 CAS 失败**：两个写入方同时初始化同一 `sessionKey`，重试一次后仍然冲突。
- ClawGPT 自行组合 fork 请求时触发了这一竞态。规避方式是：同一 `sessionKey` 的初始化必须串行执行；fork 应通过 gateway 提供的单一存储操作完成，不能组合 `chat.send` 和手动创建会话。

### 4.4 鉴权方式（修正旧版结论）
- 核心逻辑为 `roleCanSkipDeviceIdentity(role, sharedAuthOk)`：**operator 角色通过 token 验证后，可以跳过设备身份签名。**
- 设备身份签名只适用于浏览器类客户端（`openclaw-control-ui`）。面板采用服务端架构，以 operator 角色和 token 从 localhost 连接，因此不需要设备身份签名。旧版提出启用 `dangerouslyDisableDeviceAuth` 的方案不再采用；该开关既无必要，也会降低安全性。
- token 使用常量时间算法与 `gateway.auth.token` 比较；如果配置缺失，gateway 会在启动时生成一次性 token 并告警。实现时需要确认 `gateway.auth.mode=token`，并配置一个长期使用的 token 供面板服务端连接。

---

## 五、fork / 编辑重发：已确定的实现路径

这两项是**面板需要自行实现的核心功能**，gateway 没有提供直接接口。它们基于同一机制：截取截至指定消息的对话前缀，并由此前缀创建新会话。因此可以复用同一套底层实现。

### 5.1 验证结论（2026-07-11）
- **`sessions.create` 不能 fork**:有 `parentSessionKey` 但纯血缘标注,不拷历史、不接受分叉点;无 `branchFromMessageId` 之类字段。
- **`sessions.compaction.branch` 只认 compaction checkpoint**:参数仅 `checkpointId`,必须命中已存在的压缩边界。底层 fork 引擎其实能截到任意 entryId,但**没开成 RPC**。→ 短会话没 checkpoint,对日常对话不可用。
- **`chat.inject`/`sessions.steer`/`sessions.patch` 都不是编辑重发**:分别是追加注入 / 打断+追加 / 改开关,均不能截断替换历史。
- **那把写锁是纯进程内 JS mutex**(`runExclusiveSessionStoreWrite` = 内存 `Map<路径,队列>`),**不是文件锁**。→ 面板作为独立进程,与 gateway 各有自己的队列,写同一个 `sessions.json` **无法互相排队**。缓存有 mtime 校验(不会盲信过期缓存),但写时无 CAS,gateway 单次"读→等I/O→写"窗口内面板的写会被**静默覆盖**。
- **没有用于登记现有 transcript 文件的 RPC**：`sessions.create` 不接受 `sessionFile`。因此，当前版本无法采用“由面板创建文件、再由 gateway 登记索引”的方式。

**结论：“从任意消息 fork”和“编辑重发”没有安全的官方接口。** 从 checkpoint fork 虽然安全，但不能满足日常使用。

### 5.2 架构选择：路线二（独立会话数据层）
gateway 的会话索引属于其内部状态：它仅使用进程内锁，也没有对外写入接口。面板作为另一个进程直接修改该索引，会越过 gateway 的一致性边界。因此，面板有以下两种定位：

- **路线一（不采用）：面板作为 gateway 的“视图和控制端”。** 面板读取 gateway 存储并通过 RPC 操作。发消息、停止生成、读取历史、列出会话和查看记忆都容易实现，但 fork 和编辑重发仍受 gateway 限制：只能从 checkpoint fork，不能满足日常使用；或者自行引入文件锁并错开写入，但一致性保证较弱，而且高度依赖 OpenClaw 的内部存储格式。这不符合项目对可移植性和自主控制的要求。
- **✅ 路线二（Owl 已确认）：面板作为独立的会话数据层。** 面板维护自己的 transcript、fork 关系和索引；gateway 只负责 IM 收发和模型推理。IM 会话从 gateway **只读导入**，后续在面板中的消息写入面板自己的存储。fork 和编辑重发均由面板在独占存储中完成，避免并发写入冲突，也不依赖 gateway 的会话索引。代价是面板需要负责会话持久化，并处理同一会话同时从 IM 和面板续聊时的协调问题。选择这一方案，是为了保证核心会话数据可移植，不依赖 Anthropic 或 OpenClaw 的内部索引实现。

### 5.3 路线二的推理方式：方案 2a′（自主管理数据，复用 gateway 的推理能力）

**验证结论（2026-07-11）：**
- `agent`/`chat.send` **只收单条 `message` 字符串,历史只能从磁盘 transcript 文件读**,请求里塞不进 messages 数组。→ 让 gateway 基于面板的历史生成,唯一办法是把历史**物化成 gateway 能读到的文件**。
- “不持久化”模式（`sessionEffects:"internal"` + `suppressPromptPersistence`）确实存在，但**只向 backend 身份的客户端开放**，普通客户端无法使用；而且历史上下文仍然需要通过文件提供。因此，无法把 gateway 当作完全无状态的推理接口使用。
- 直接连接 mini1 将失去 gateway 提供的系统提示、MEMORY 记忆注入、不可信上下文隔离、指令解析，以及 browser、canvas、skills 等工具和技能装配能力。

**选定方案 2a′（混合架构），核心桥接已于 2026-07-11 实测通过。** 责任划分如下：
> **面板独占写入 transcript 文件及自身索引；gateway 独占写入 `sessions.json`。两个进程不写入同一文件，从架构上避免进程内锁无法协调跨进程写入的问题。**

- 实测可行流程是：调用 `sessions.create` 取得 gateway 已登记的一次性 session；覆盖其 transcript，只物化到上一轮完整 run；用 `sessions.send` 提交尚未写入文件的最新用户消息；完成后从临时 transcript 取得新增的完整 entry 组。最新用户消息只出现一次。一次性 session 不复用。
- `sessions.delete` 能注销索引，但 transcript 只会改名为 `.deleted.*`，trajectory 文件仍会残留。因此 Owl 已选择：每个真实 agent 配置一个无渠道绑定的专用 runtime agent，与目标 agent 共用 workspace、sessions 目录隔离；先用官方 RPC 注销，再在 runtime agent 的 sessions 根目录内执行严格受限的 artifact 清理。不维护 OpenClaw 补丁分支。
- 清理只接受本轮由服务端创建并记录的 sessionId 和当前版本已知文件类型；拒绝符号链接、路径越界、未知文件和非 allowlist runtime 根目录。OpenClaw 版本不是 `2026.6.11` 时拒绝推理和清理，升级后须重新验证。
- 权威会话数据采用 OpenClaw transcript 的 JSONL 格式存储，便于直接查看、纳入 Git 管理和迁移。fork 或编辑重发时，面板以 `wx` 模式创建**新的分支 transcript 文件**，避免覆盖现有文件。
- 需要生成回复时，面板将该分支的历史写入临时推理会话文件，再通过 RPC 让 gateway 基于该文件执行**一次**推理。gateway 在 `sessions.json` 中产生的条目仅作为推理工作区；面板不将其作为权威会话数据，使用后即可 reset 或归档。
- **面板从不写 sessions.json → 跨进程写冲突在此架构里不会发生。**
- 这样可以保留 OpenClaw 的系统提示、记忆注入、工具和技能、memory promote 及 REM 反思，无需重新实现这些能力。
- 代价是保留一层对 OpenClaw 的**软耦合**，包括 transcript 格式和推理注入层。核心数据仍由面板管理；如果将来更换 OpenClaw，只需替换推理适配层。

**不采用的方案：**方案 2a（模拟 backend 身份以启用 internal 模式）依赖未公开的权限机制，兼容性风险较高；方案 2b（直接连接 mini1 并自行实现 agent runtime）需要重做 OpenClaw 的大量能力，也会与现有的 memory promote / REM 机制冲突。

### 5.4 2a′ 的能力边界与必要约束

**两种记忆归档机制的适用情况不同：**
- **cron 归档（promote → `MEMORY.md` / REM → `DREAMS.md`）仍然有效。** 该机制以 workspace 为单位，由 cron 驱动并读取短期 recall store，不依赖推理工作区会话是否继续保留。因此，推理完成后清理工作区会话不会影响它。
- **压缩前的 memory flush 基本不会触发。** 该机制要求活跃会话累积到压缩阈值，而本方案会在单次推理后清理工作区会话。

**⚠️ 必须遵守的约束：** recall store 的内容来自 agent 推理期间调用 `memory_search` 的结果，并按 `workspaceDir` 归档。为保证 cron 归档持续工作，面板发起的推理必须：（1）使用**固定的 `workspaceDir`**；（2）保留完整的 prompt 和工具配置，**不得使用 `promptMode:none/minimal` 移除 `memory_search`**。默认配置已经满足这两项要求。

**通过 gateway RPC 可直接复用的能力：**系统提示组装；SOUL、USER、MEMORY、IDENTITY、HEARTBEAT、BOOTSTRAP 的具名注入（首轮或满足条件时）；每日记忆注入；不可信上下文隔离；`memory_search` / `memory_get` 工具装配；cron promote / REM（需满足上述约束）；指令解析和 prompt prelude。

**需要面板处理或上线前验证的能力：**压缩前 memory flush 无法依赖；尚未确认 `AGENTS.md` / `TOOLS.md` 是否会自动注入，如有依赖，应由面板加入 `extraSystemPrompt`；browser、canvas、skills 等非记忆扩展机制预计可以沿用，但需逐项进行上线前测试。

**由此产生的核心责任：**面板每次提供完整历史，gateway 不会持续累积并压缩同一会话，因此**长对话的截断和压缩必须由面板负责**。第一版已实现保守预算保护：在触达 gateway 前估算完整历史与本轮消息，超过可配置安全预算就返回 `CONTEXT_BUDGET_EXCEEDED`，不写 transcript，并提示从较早位置 fork；不会静默截断或伪造摘要。后续仍需设计正式压缩策略。若需保留相关记忆，应在压缩点执行一次侧重 `memory_search` 的推理，以补充记忆归档。

### 5.5 验证阶段结论
源码侦察和第 0 段实验已经确定：存储规则、RPC 清单、冲突根因、鉴权分支、完整工具 run 的取得方式，以及“创建一次性 session → 覆盖 transcript → `sessions.send`”的桥接流程。临时文件不能仅靠官方 RPC 清净删除，采用上一节所述的专用 runtime agent 和受限清理。

尚待细测但不影响当前架构的项目包括：逐 token 事件、`memory_search` recall 落盘和 browser/canvas/skills 注入。命令明确不在首版范围。完整记录见 `实测记录.md`。

---

## 六、会话模型与交互设计

### 6.1 两层会话模型
面板里存在两类会话，写入归属不同：

**活会话（gateway 管理、绑定 IM 的会话，如 `agent:claude:main`）**
- 面板对它是「读 + 刷新」：只读该会话文件，轮询刷新即可看到 IM（Telegram / 飞书）刚追加的消息。
- 关键理解：**会话文件才是完整、连续的上下文，IM 里看到的只是这个上下文的一个窗口。** 例：claude 的 main 会话同时挂了 Telegram 和飞书，在公司用飞书聊、回家用 Telegram 接着聊，上下文是连续的，因为消息都写进同一个桶。面板作为第三扇窗口读同一个文件，看到的是完整内容。
- 面板要往活会话发消息时，不自己写文件，而是调 gateway 的 `chat.send`，由 gateway 追加。面板由此成为与 Telegram、飞书并列的第三扇窗口，消息进同一段上下文。

**面板自建会话（在面板中新建或 fork 产生）**
- 文件由面板自己拥有，走 §5.3 的推理桥接，在固定 workspace 里跑推理。
- 从活会话某条消息 fork，产出的就是这类会话。

这个两层模型统一支撑了需求 1、3、4、6。

### 6.2 fork 与编辑重发的呈现
- fork 在侧边栏产生一条**独立会话**（不是在同一视图内切换分支）。fork 来源作为元数据记录，条目上标注「fork 自 XX」。
- 每个消息节点带「从这里 fork」按钮（与 Claude Code、Cursor 一致）。
- 编辑重发：从被编辑消息的父节点截断，接上新消息，同样得到一条独立的新会话。
- 两者共用「拷贝对话前缀、派生新会话」的底层函数（见 §5）。

### 6.3 流式与多端同步（两套不同机制）
- **运行状态流**：当前正在生成的 run 走 SSE，首版推送生命周期事件，完成后整组返回 entries。
- **多端同步**：设备之间靠轮询，每隔几秒同步一次，不做广播推送。其他设备看到的是「已生成完的整条」，不看中途状态。与 claude.ai 的表现一致，协议也更简单。
- **依赖实测**：gateway 的推理 RPC 是否提供流式 token。提供，面板才能中转成 SSE；不提供则只能整段返回。列入待实测项。

### 6.4 工具调用与思考过程展示
- transcript 里 tool_use / tool_result 是独立的 content block，扩展思考块同理。
- 对解析器构成硬要求：**保留所有类型的 content block，不能只留 text**（与实现规格 §3 数据格式「序列化写回逐行一致」的验收对齐；本文档 §4.1 记录了会话文件格式）。
- UI 默认折叠工具调用和思考块，可展开查看（与 Claude Code 一致）。

### 6.5 OpenClaw 自带命令
- **v1 现状**：面板不提供命令入口；普通消息发送路径拒绝所有以 `/` 开头的输入（`SLASH_COMMANDS_UNSUPPORTED`），防止命令被误当普通消息送入推理桥接。
- **适配方向（2026-07-12 源码核实后确定）**：命令在 gateway 是「带内」执行的——没有命令执行 RPC，`/xxx` 是作为普通消息文本喂给 `sessions.send` 才触发分派。而面板当前以 `operator.admin` scope 连接，任何漏进桥接的 `/` 文本都会被自动授权执行。因此拒绝 `/` 进入普通消息路径是**必需的隔离防线**，不是保守。
- **重定位**：斜杠命令原本是为 gateway 管理的会话设计的；在 2a′ 里面板自建会话的状态由面板自己拥有。所以「支持命令」的大部分其实是**用命令名与交互提供面板原生的等价能力**，而非转发给 gateway。命令按「谁拥有这个效果」分四类：
  - **A 面板原生**（`/model` `/think` `/reasoning` `/new`）：存进面板会话 metadata，推理时应用到临时 session；顺带实现 §8.6「会话中途换模型」。当前已实现。
  - **B `/compact`**：面板会话无持久 gateway session 可压，做法是「物化临时 session、调用 `sessions.compact` typed RPC、读回压缩后的 transcript、采纳进面板存储」——即长上下文策略本身，与之合流。
  - **C 信息类**：首批做 `/commands`、`/help`、`/status`、`/models`；`/tools`、`/usage` 在数据来源与 DTO 核实后再扩展 allowlist。
  - **D gateway 管理 / owner 全局**（`/config` `/restart` `/reset` 等）：属 gateway 控制台范畴，面板默认不做。`/bash` 仅记录为未来可能的面板原生进程执行能力，当前不实现、无启用开关。
- **交互**：输入框敲 `/` 触发命令补全（因 skill 命令动态注册、列表点选不实用），选中后走**独立的命令派发路径**，不经拒绝 `/` 的普通消息接口。两条路径隔离是安全前提。
- 面板可执行范围由服务端版本化、default-deny allowlist 决定；每个命令映射到面板原生操作或已核实的只读 typed RPC/CLI，绝不复刻或调用 gateway 的带内命令分派。动态命令目录可用于补全展示，但不自动扩大可执行权限。完整分类适配设计与源码依据见 [`decisions/slash-commands.md`](decisions/slash-commands.md)。

### 6.6 多 agent（联系人页模型）
- 一个面板管理多个 agent（`main` 喵团子、`claude` 等），像联系人页那样切换，各自的会话列表分开。
- 每个 agent 有独立的 workspace 和会话目录（`~/.openclaw/agents/<agent>/sessions/`），面板按 agent 分别扫描、分别索引。

### 6.7 向真实活会话发送消息的安全边界 ⚠️

**首版结论：不开放这条写链路。**真实 active 会话与 reset 归档只读；用户需在原有 OpenClaw surface 继续，或 fork 为 panel 会话后在面板续聊。以下内容仅保留为未来版本的风险依据。
- 面板**读**真实 agent 的会话（拷贝、只读、轮询刷新）没有风险，无人自主开发时可对真实 agent 验证。
- 面板**发**消息到真实活会话（如 `agent:claude:main`）时，gateway 生成的回复会按会话记录里的 route 投递，**很可能同时发到 Owl 真实的 Telegram / 飞书**，且发出即不可撤回。
- 这条是否会漏到 IM，属于待实测项，且应在接真实 agent、Owl 在场时验证（测试 agent `paneltest` 未绑任何渠道，消息漏不出去）。
- 对无人自主开发的含义：多 agent 的「读和界面」可对真实 agent 验证；唯独「面板向真实活会话发送并生成回复」这一步，需 Owl 在场，或先只对 `paneltest` 验证发送。

### 6.8 会话管理：重命名、归档、删除

三类会话（活会话、reset 归档、面板自建）写入归属不同（§6.1），因此管理动作的边界也不同。核心原则：**对只读源文件的任何“删除/隐藏”都不得触碰源文件本身，只改面板侧的记录。**

**重命名（所有会话）**
- 标题是面板侧 metadata，不是源文件内容。重命名任何会话（含只读的活会话与 reset 归档）都只改面板对它的记录，不写源文件。
- 未命名会话的默认标题：截取首条用户消息（不自动调用模型生成）。

**归档（所有会话，统一机制）**
- 归档把会话从主列表移入归档列表：既用于“收起暂时不想看的会话”，也作为“彻底删除前的安全闸”。
- 归档可逆：可取消归档，恢复回主列表。
- 归档状态是持久化的面板 metadata，重新扫描源目录不会让被归档/隐藏的只读会话重新出现在主列表。

**删除（按会话类型分开）**
- **只读会话（活会话 / reset 归档）**：面板里的“删除”只能是**从视图和索引中隐藏**，**永不 unlink、改名或改写源文件**（违反 §0 安全约束）。源文件始终由 gateway / OpenClaw 拥有。注意「隐藏」与「归档」是两个独立状态、不能混：归档只读会话仍在归档列表可见，删除（隐藏）则从主列表和归档列表都移除。数据层用 `archived` 与 `hidden` 两个正交字段承载，见 implementation-spec §4.3。
- **面板自建会话**：**归档后才允许彻底删除**。彻底删除会真正移除面板拥有的 transcript 与 metadata 文件；最后一层恢复依赖数据目录已纳入的 git（git-crypt）历史，面板不再单独维护回收站层。彻底删除是显式、二次确认的动作，不是归档的默认结果。

这一模型与项目立意（“what you refuse to leave behind”）的调和方式是：默认永不真正丢弃会话，归档让列表保持整洁；只有面板自建且用户明确不再需要的会话，才在归档后经二次确认彻底删除，且 git 历史仍是兜底。

---

## 七、实现分工速查(给 Codex 的骨架)

| 功能 | 实现方式 | 难度 |
|---|---|---|
| 发消息 | 调 `chat.send` | 直接 |
| 停止生成 | 调 `chat.abort` / `sessions.abort` | 直接 |
| 拉历史 / 实时更新 | `chat.history` + `sessions.messages.subscribe` | 直接 |
| 看记忆 | 服务端直接读 workspace 文件(`~/claude/MEMORY.md` 等) | 直接 |
| **列全部会话(含 reset)** | **服务端自己扫 `sessions/` 目录**建索引 | 中,规律清晰 |
| **从任意点 fork** | 面板截取对话前缀并创建新的 transcript 分支，见 §5 | 重，核心功能 |
| **编辑重发** | 同 fork 一套机制 | 重,与 fork 同源 |
| 浏览器侧登录/登录态 | 面板自己实现(SSH 隧道后,可从简) | 中 |
| 面板↔gateway 连接 | operator + token,localhost WS,**无需设备签名** | 直接 |

---

## 八、技术选型

- **面板服务端语言：Node（已确定）。** 与 OpenClaw 技术栈一致，可能复用现有客户端或协议 schema。实现前先确认 OpenClaw 是否导出了可复用的 JavaScript 客户端或协议 schema，能复用则复用。
- fork 实现路径已经在 §5 中确定。

---

## 九、附:关键路径与命令
- gateway 配置:`~/.openclaw/openclaw.json`
- claude agent 会话:`~/.openclaw/agents/claude/sessions/`(索引 `sessions.json` + `<uuid>.jsonl` + `.reset.` 归档)
- openclaw 打包源码:`~/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/dist/`
  - 会话文件名分类 `paths-*.js`;store `store-*.js`;RPC 描述符 `core-descriptors-*.js`;handler `sessions-*.js`;fork `session-fork*.js`;冲突抛点 `get-reply-*.js`;鉴权 `auth-*.js` + `message-handler-*.js`
- 待做(与面板并行、独立):`session.dmScope per-channel-peer` 解 TG/飞书串会话(已授权)
