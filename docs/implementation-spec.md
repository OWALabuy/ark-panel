# ark-panel 实现规格

> 设计依据、备选方案的取舍与侦察过程见 [`architecture.md`](architecture.md)，本文集中说明“建什么、怎么建、怎么验收”。
> 面向 Codex 无人监督时的自主开发：每个任务都带一个 Codex 自己能跑、能判断通过或失败的验收方式。
> 写于 2026-07-11。
> **范围更新（2026-07-12）：**真实 active 会话与 reset 归档只读；只有 panel 自建/fork 会话可写。当前实现已提供 A 类面板原生命令与首批 C 类只读命令（`/commands`、`/help`、`/status`、`/models`）。普通消息接口仍永久拒绝 `/...`，命令只走独立结构化派发接口。见 [`decisions/slash-commands.md`](decisions/slash-commands.md)。

---

## 0. 最高优先级：安全约束（违反即停止）

这些约束高于一切开发目标。任何一条无法保证时，停下等 Owl 醒来确认，不要绕过。

1. **绝不接触真实 agent `claude`。** 它的 workspace 是 `~/claude`，会话目录是 `~/.openclaw/agents/claude/sessions/`。开发和测试期间对这两个位置**只读、且只读拷贝**，不写、不删、不改。真实的 `MEMORY.md`、`memory-seed`、几年的对话是本项目唯一无法重建的资产。
2. **测试只用隔离的测试 agent。** 见 §1，Codex 自己创建一个测试 agent + 空 workspace，所有需要连 gateway 的测试都跑在它身上。
3. **测试 agent 不绑任何 IM 渠道。** 不执行 `openclaw agents bind`。这样 `chat.send` 没有对外出口，不会把测试消息发到 Owl 的 Telegram 或飞书。
   - 补充依据：`chat.send` 的投递目标来自会话记录里的 `route` / `deliveryContext` 字段（见方案文档 §4.1 的索引结构）。测试 agent 没有渠道绑定，新建会话就不会带 IM route，消息无处可发。
4. **面板服务端永不写 `sessions.json`。** 这是整个架构的前提（见方案文档 §5.3）。面板只写自己的存储目录。
5. **不改 `~/.openclaw/openclaw.json` 里与真实 agent、真实渠道相关的任何配置。** 只允许追加测试 agent 相关的项。
6. **不执行 git push、不改 git 配置、不碰 git-crypt 密钥。** 提交可以，推送等 Owl 醒来。
7. **控制测试推理的工具副作用。** `paneltest` 不绑 IM 只挡住了 Telegram / 飞书，挡不住其它有外部影响的工具：浏览器操作、网络请求、文件写入、shell 命令、发外部消息的技能。为验证「完整工具是否注入」而跑推理时，测试 prompt 必须受控（用明确无副作用的问题，例如“列出你能用的工具名称”而非“上网查 X 并发给我”），或给 `paneltest` 收窄工具集。绝不用会真正触发外部动作的 prompt——那同样不可逆。

---

## 0.5 第 0 段：推理桥接可行性实验（已完成）

第 0 段已于 2026-07-11 在 `paneltest` 完成。桥接成立，当前采用 2a′；详细证据和未完成的扩展测试见 `实测记录.md`。

已确定的主流程：`sessions.create` 创建一次性临时 session；覆盖其 transcript，只写到上一轮完整 run；通过 `sessions.send` 提交最新用户消息；等待完成后从临时 transcript 读取新增的完整 entry 组。临时 session 不复用。

实验程序是不带 UI 和正式持久化的最小脚本，只操作 `paneltest`。复现脚本保存在 `experiments/bridge-zero.sh`。

**实验结果：**

1. **gateway 读取预置历史：通过。** 必须先 `sessions.create`，再覆盖它创建的 transcript；直接放置未登记文件不可用。
2. **最新用户消息不重复：通过。** 物化历史不含最新用户消息，只经 `sessions.send` 提交；搬回时校验并跳过 gateway 新增的 user entry。
3. **完整工具 run：通过。** `sessions.send` 的直接响应不足以重建；应在 run 完成后读取临时 transcript 新增的完整 JSONL entries。
4. **abort 与客户端退出：基础行为通过。** abort 留下结构完整的 entry；客户端退出后 gateway 仍完成推理。强制杀死自定义 WebSocket 客户端和 gateway 重启恢复尚未测试，不作为当前架构前提。
5. **官方清理：不完整。** `sessions.delete` 能注销，但 transcript 会改名，trajectory 仍残留；已选择专用 runtime agent + 受限文件清理。
6. **累积结论：已足够确定。** 每轮至少产生 transcript 和 trajectory artifacts，官方删除后仍线性累积；没有在已知结论后继续浪费模型调用。受限自动清理完成后再做耐久测试。
7. **记忆 / 系统文件 / skills 的实际注入。** 确认面板发起的推理里，`SOUL/USER/MEMORY` 等具名文件确实被注入（发一条能触发记忆的消息看回复），`memory_search` 跑完后 recall store 有新数据落盘，browser/canvas/skills 等工具是否随推理带上。

**实验产出**：`实测记录.md`。Owl 已根据结果选择专用 runtime agent + 受限 artifact 清理，不维护 OpenClaw 补丁分支。

---

## 1. 隔离测试环境（Codex 开工第一步）

在写任何面板代码前，先建好隔离环境，并确认它与真实 agent 分离。

创建测试 agent（名字用 `paneltest`，workspace 用一个新目录）：

```bash
mkdir -p ~/paneltest-workspace
openclaw agents add paneltest --non-interactive \
  --workspace ~/paneltest-workspace \
  --model 'mini1/claude-opus-4-8' \
  --json
# 注意：不执行 agents bind，测试 agent 不接任何 IM 渠道
```

验收（Codex 自查，全部满足才算环境就绪）：
- `openclaw agents bindings` 输出里，`paneltest` **没有**任何 channel 绑定。
- `~/.openclaw/agents/paneltest/sessions/` 目录存在，且与 `claude` 的会话目录是不同路径。
- `openclaw.json` 里 `claude` agent 的配置项逐字未变（改动前后 diff 只多出 `paneltest`）。

gateway 连接凭证：读 `~/.openclaw/openclaw.json` 的 `gateway.auth.token`。若为空，说明 gateway 用的是启动时生成的临时 token，此时**停下**，在任务清单里记一条“需要 Owl 配置固定 token”，先做不依赖 gateway 的部分（见 §6 分段）。

---

## 2. 目标架构（一句话回顾）

面板是一个 Node 服务端，与 gateway 同机运行。它自己保存会话历史（真相），gateway 只负责两件事：跑模型推理、收发 IM。

```
浏览器（手机 / 公司 Windows / 家里 Linux）
   │  HTTP / WebSocket
   ▼
面板服务端（Node，与 gateway 同机）
   ├─ 自己的会话存储：transcript 文件 + 索引 + fork 关系
   └─ 通过 localhost WebSocket 连 gateway：只为跑一次推理
        │
        ▼
   gateway（127.0.0.1:18789）
```

浏览器只连面板服务端。外部设备通过 SSH 转发面板一个端口即可（见方案文档 §2）。

---

## 3. 会话数据格式（面板自己的存储）

面板用 OpenClaw 的 transcript 格式存会话，便于直接查看、纳入 git、以后迁移。

**每个会话是一个 JSONL 文件**，每行一个 JSON 对象：
- 首行是会话头：`{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<workspace路径>"}`
- 消息行：`{"type":"message","id":"<短id>","parentId":"<父id或null>","timestamp":"<ISO>","message":{"role":"user|assistant","content":...}}`
- 其它类型（`model_change`、`thinking_level_change`、`custom`）按原样保留，不必理解其语义，但要能读能写回。

**关键：`id` + `parentId` 构成一棵树。** fork 就是让新消息的 `parentId` 指向历史上某个节点。面板的 fork 树直接建立在这个父子关系上。

**面板存储目录布局建议**（Codex 可调整，但要在代码里写清楚）：
```
<面板数据目录>/
  sessions/
    <会话uuid>.jsonl          # 每条会话线一个文件
  index.json                  # 面板自己的会话索引（见 §4）
```

参考样本：可以把 `~/.openclaw/agents/claude/sessions/` 里的文件**拷贝出来**做解析测试样本，绝不直接读写原目录。

验收：
- 写一个解析器，能读入一个 v3 transcript 文件，还原成消息树（每个节点知道自己的父节点和子节点）。
- 用拷贝出来的真实样本测试：解析后再序列化写回，与原文件逐行对比应一致（除了可以接受的空白差异）。
- 单元测试覆盖：多分支的树、`parentId` 为 null 的根、非 message 类型行的保留。

---

## 4. 面板自己的会话索引

gateway 的 `sessions.json` 面板不碰。面板维护自己的索引 `index.json`，用于侧边栏列表和搜索。

**索引只作可重建缓存，不作第二份权威数据。** 权威信息（如 fork 来源）应写进 transcript 头部或独立的、同样可从磁盘重建的元数据文件；`index.json` 随时可以删掉，从扫描 transcript 全量重建。写入采用「临时文件 + fsync + 原子改名」，避免崩溃时留下半个索引。

#### 4.1 会话记录的字段（修正：`id` 不能等于会话 uuid）
一个会话 uuid 不足以唯一标识一条记录：`/reset` 会让同一个 uuid 先后产生 `<uuid>.jsonl`、`<uuid>.jsonl.reset.<时间1>`、`<uuid>.jsonl.reset.<时间2>`，它们很可能共享同一个 session uuid；不同 agent 之间也需要命名空间。因此每条记录用一组字段标识：

- `recordId`：**面板内部全局唯一 ID**（自己生成，不等于会话 uuid）。
- `agentId`：来自哪个 agent（`claude` / `main` / `paneltest`）。
- `sourceSessionId`：源会话 uuid（可能多条记录共享）。
- `sourceKind`：`active`（活会话）｜`reset`（reset 归档）｜`panel`（面板自建）。
- `sourcePath` 或稳定归档标识：源文件路径 / 归档标识。
- `sourceRevision`：mtime + size（或内容摘要），用于判断源文件是否变化、要不要刷新。
- `title` / `createdAt` / `updatedAt` / `messageCount`。
- `parentRecordId` + `forkedFromMessageId`：从别处 fork 出来时记来源（指向 `recordId`，不是 uuid）。

#### 4.2 三类会话的对待方式（修正：不再一律「拷贝进存储」）
之前「只读拷贝进面板存储」与「活会话直接读真实文件」是矛盾的。明确区分：

- **活会话**（`<uuid>.jsonl`，gateway 在管）：**只读源文件 + 建立派生索引，不拷成权威副本。** 轮询刷新时按 `sourceRevision` 判断源文件是否变了，变了就重读。这样才能看到 IM 刚追加的新消息（对应方案 §6.1）。
  - 读正在被追加的文件时，要处理「读到半行」：按完整行解析，最后不完整的一行丢弃、下次再读。
- **reset 归档**（`<uuid>.jsonl.reset.<ts>`）：内容不再变化，**首次发现时导入为不可变快照**，之后不必重读。
- **面板自建 / fork**（`sourceKind: panel`）：文件本就由面板拥有，直接是权威数据。

**导入范围**：扫描 `~/.openclaw/agents/<agent>/sessions/`（测试期 `paneltest`），识别活会话和 reset 归档；只要求现行格式，早期 `-topic-N` 可跳过。多 agent 分别扫描、分别登记。

验收：
- 索引能列出面板自建 + 各 agent 导入的会话，包括 reset 归档；同一 uuid 的活会话与多个 reset 归档各占独立记录，不互相覆盖。
- 删掉 `index.json` 后能从扫描 transcript 全量重建，结果一致。
- 搜索：按标题和消息内容关键词能查到会话。
- 活会话源文件被追加新行后，轮询刷新能读到新消息，且不会因读到半行而解析出错。

#### 4.3 会话管理字段（重命名 / 归档 / 删除 / 记忆倾向）

以下都是**面板侧 metadata**，是可从磁盘重建之外的用户意图状态，必须持久化，且**对只读会话绝不写回源文件**。放在面板 metadata（transcript 头或独立元数据文件），不能只放 `index.json`（索引可删可重建）。

- `title`：用户可改的标题。重命名任何会话（含活会话、reset 归档）只改这里。未设置时展示用截取首条用户消息，不落库为 `title`。
- **`archived` 与 `hidden` 是两个独立状态，不能用一个布尔表达**（否则「归档页可见」和「彻底隐藏」区分不出）：
  - `archived`（布尔）：归档 = 从主列表移到**归档列表**，在归档列表**仍可见**、可取消归档移回主列表。这是「暂时不想看，但要能找回」。
  - `hidden`（布尔）：隐藏 = 主列表与归档列表**都不默认展示**。这是「删除」对只读会话的落地形态（源文件永不动，只是面板不再列出）。
  - 两者正交：一条会话可以 `archived=true, hidden=false`（在归档页），也可以 `hidden=true`（哪儿都不列，无论 archived 取值）。彻底删除只读会话 = 置 `hidden=true`。
  - 状态在重新扫描源目录后仍生效：被归档 / 隐藏的只读会话不因 rescan 重新出现。
- `memoryDisposition`：`eligible`｜`scratch`（默认值与语义见 §5.5 与 `decisions/panel-memory.md`）。
- 只读会话（`sourceKind` = `active` / `reset`）的“删除”= 置 `hidden=true`；**没有任何路径可 unlink、改名或改写其源文件**。
- 面板自建会话（`sourceKind` = `panel`）的彻底删除：必须先 `archived`，再经显式二次确认，才移除面板拥有的 transcript 与 metadata；git（git-crypt）历史为最后兜底。

**只读会话的 metadata 存储（sidecar）**：只读会话（`active` / `reset`）的源文件在 gateway 目录，面板绝不写回；它们的 `title` / `archived` / `hidden` / `memoryDisposition` 需要一处面板自有的 sidecar 存储：

- **存储位置**：面板数据目录下**镜像 agent 维度的 sidecar 目录**（如 `PANEL_DATA_DIR/readonly-meta/<agentId>/<sourceIdentity>.json`），与源目录物理隔离，只由面板拥有、原子写（沿用 §0 `atomicWrite` 与路径/符号链接防护）。不复用 panel 自建会话的 `sessions/<agent>/<recordId>/` 目录。
- **源身份（source identity）**：用**稳定标识**关联源会话，不是易变的文件名。`active` 用会话 uuid；`reset` 归档（`<uuid>.jsonl.reset.<ts>`）用 `uuid + reset 时间戳`组合。选稳定标识的目的：源文件被 rescan 重新发现、或 reset 文件路径变化时，sidecar 仍能重新挂到同一逻辑会话上，用户设的标题 / 归档态不丢。
- **schema 版本化**：sidecar JSON 带 `version` 字段（起始 `1`），与 panel metadata 同一套升级方法（读到未知版本报错，不静默丢字段）。
- **v1 精确 schema**：`{ version: 1, sourceKind: "active"|"reset", agentId, sourceSessionId, resetTimestamp?: string, title?: string, archived: boolean, hidden: boolean, memoryDisposition: "eligible"|"scratch", updatedAt }`。`resetTimestamp` 仅 `reset` 必填；`title` 缺失表示使用首条用户消息的展示标题。读取旧 sidecar 时缺失的布尔按 `false`、缺失的 `memoryDisposition` 按 `scratch` 补齐，并在下一次修改时写回完整 schema。
- **安全文件名**：`sourceIdentity` 是逻辑键，不直接拼进路径；文件名使用 `sha256(agentId + "\0" + sourceKind + "\0" + sourceSessionId + "\0" + (resetTimestamp ?? "")) + ".json"`。JSON 内保留组成字段，读取时重新计算并校验文件名，拒绝不一致记录。
- **原子更新与并发**：sidecar 写用 `atomicWrite`（临时文件 + fsync + rename）；每个 `sourceIdentity` 使用服务端 keyed mutex 串行执行完整的 read-modify-write，避免同进程并发请求发生丢失更新。不同 identity 可并行。gateway 不知道该目录，不存在跨 gateway 竞争。

验收：
- 重命名活会话与 reset 归档：面板 sidecar 记录的 `title` 改变，**源文件字节逐字未变**（改动前后对源文件做 diff 应为空）。
- 归档某会话后，它从主列表消失、出现在归档列表；取消归档后回到主列表。删除 `index.json` 重建后，归档 / 隐藏状态保持一致（说明状态存 sidecar / panel metadata，不只存索引）。
- 只读会话执行“删除”（置 `hidden=true`）：源文件仍在原处、内容未变；主列表与归档列表都不再默认展示它。
- `archived` 与 `hidden` 正交可验：一条会话 `archived=true` 时在归档列表可见；再置 `hidden=true` 后从归档列表也消失；两状态可独立切换。
- reset 源文件被 rescan 重新发现后，此前设的 `title` / `archived` / `hidden` 仍挂在同一逻辑会话上（source identity 稳定，不因文件重新扫描而丢关联）。
- 并发更新同一 sidecar 的不同字段（例如同时重命名和归档）后两项都保留；测试用 barrier 让两个请求重叠，证明 keyed mutex 覆盖完整 read-modify-write，而不只是原子 rename。
- 面板自建会话未归档时，彻底删除入口不可用（或被拒绝）；归档并二次确认后，面板 transcript 与 metadata 被移除，且该操作不触碰任何非 `panel` 会话。
- 路径与符号链接防护沿用 §0 与工程决定：删除只作用于由 agentId + recordId 推导出的面板数据目录内文件，拒绝路径越界与符号链接；sidecar 写入同样受此约束。

---

## 5. 功能实现对照表

面板里存在两类会话，写入归属不同（详见方案文档 §6.1）：
- **活会话**：gateway 管理、绑定 IM 的会话（如 `agent:claude:main`）。面板对它只读 + 轮询刷新；要发消息则调 gateway `chat.send`，由 gateway 追加到同一个上下文桶。面板由此成为与 IM 并列的又一扇窗口，消息进同一段上下文（注意：这不等于两类会话能力相同——fork 出的自建会话就不回 IM，见方案 §6.1）。
- **自建会话**：面板中新建或 fork 产生。文件由面板自己拥有，生成回复走 §5.1 推理桥接。

| 功能 | 实现方式 | 连 gateway？ |
|---|---|---|
| 查看会话历史 | 读 transcript（自建会话读面板存储；活会话只读其真实会话文件） | 否 |
| 侧边栏列表 / 搜索 | 读面板 `index.json` | 否 |
| 多 agent 切换（联系人页） | 按 agent 分别扫描 `~/.openclaw/agents/<agent>/sessions/`、分别索引 | 否 |
| 多设备同步 | 浏览器每隔几秒轮询服务端，看到已生成完的整条（不看中途状态） | 否 |
| 看记忆 | 低优先级，MVP 不做（见 §6） | — |
| 从某条消息 fork | 面板从目标 entry 沿 `parentId` 回溯出祖先链，写成一个新 transcript 文件，`wx` 模式创建（存在即失败，防覆盖），头部记来源。见 §5.0 | 否（纯文件操作） |
| 编辑某条消息重新生成 | 与 fork 同一套机制：回溯到被编辑消息的父节点，接上编辑后的新消息，得到一条新分支。见 §5.0 | 否（生成回复那步才连） |
| 发消息到活会话 | **首版不支持，活会话只读**；继续在原有 OpenClaw 渠道发送 | 否 |
| 生成回复（自建会话） | 见 §5.1 推理桥接 | **是** |
| 运行状态流 | SSE 推送 run 生命周期；首版完成后整组返回 entries，不宣称逐 token | **是** |
| 停止生成 | `chat.abort` 或 `sessions.abort` RPC | **是** |
| 工具调用 / 思考块展示 | 解析器保留所有 content block；UI 默认折叠、可展开 | 否 |
| Markdown 渲染 | assistant 文本按 Markdown 渲染，走安全 DOM（沿用工具/思考块同一套无 XSS 渲染），见 §8.7 | 否 |
| 消息复制 / 代码块复制 | 整条消息复制到剪贴板；每个代码块单独复制。见 §8.7 | 否 |
| 消息时间显示 | 读 entry 的 `timestamp`，按浏览器本地时区渲染日期时间。AI 感知时间不做，交给 gateway | 否 |
| 会话重命名 | 改面板侧 metadata 的 `title`，不写源文件；对只读会话同样只改面板记录。见 §4.3 | 否 |
| 会话归档 / 取消归档 | 面板 metadata 的 `archived`（与 `hidden` 正交）；归档会话仍在归档列表可见；rescan 不复现。见 §4.3 | 否 |
| 会话删除 | 只读会话=置 `hidden`（主列表与归档列表都不列，永不碰源文件）；面板自建会话=归档后经二次确认彻底删除面板文件，git 兜底。见 §4.3 | 否 |
| 会话记忆倾向标记 | 面板 metadata 的 `memoryDisposition`（`eligible` / `scratch`）；scratch 会话推理收窄记忆副作用。见 §5.5 与 `decisions/panel-memory.md` | 生成时相关 |
| OpenClaw 自带命令 | 普通消息路径永久拒绝 `/`；命令走独立派发接口，下一批做 A（面板原生）+ 首批 C（只读信息类），D 类默认不做；`/bash` 当前也不实现。见 §5.4 与 `decisions/slash-commands.md` | C 类只读 RPC/CLI 相关 |
| 登录 | 账号密码，保持登录态；纯本地，不连 gateway | 否 |

fork 和编辑重发共用底层（见 §5.0）：都是「从目标 entry 回溯祖先链，派生出一条新会话线」。先实现这个底层函数，两个功能都基于它。

**解析器硬要求**：transcript 里 tool_use / tool_result 和思考块都是独立 content block，解析和序列化必须**保留所有类型的 content block，不能只留 text**。这条与 §3“序列化写回逐行一致”的验收相互印证。

### 5.0 fork / 编辑重发的底层：回溯祖先链（不是复制文件前缀）

**为什么不能简单「拷贝文件到该行为止」**：transcript 是 `id + parentId` 构成的树，源文件里可能已经有分叉。文件里物理排在目标消息之前的行，不一定是目标消息的祖先——可能是别的分支。所以「文件前缀」≠「目标消息的上下文」。

**正确做法**：
1. 从目标 entry 出发，沿 `parentId` 一路回溯到根，得到这条**祖先链**（有序的 entry 列表）。
2. 保留这条链依赖的非 message 条目（`model_change`、`thinking_level_change`、`custom` 等落在链上的）。
3. **tool_use 和它对应的 tool_result 不能拆开**：如果祖先链的截断点落在一次工具调用中间，要把这一组一起纳入或一起排除，不能只留半边（否则下一轮模型看到一个没有结果的工具调用，上下文不完整）。
4. compaction、model_change 等特殊 entry 如何继承：跟随祖先链，落在链上就带上。
5. 生成新的 session 头（新 `recordId`）和来源元数据（`parentRecordId` + `forkedFromMessageId`）。

**消息 ID 的处理**：新分支里，祖先链上的 entry 可以沿用原 `id`（在单个 transcript 内仍唯一）。但要清楚：这样 `id` 只在本 transcript 内唯一，不是全局唯一。若以后要做跨会话的全局搜索或引用，必须带上 `recordId` 命名空间（`recordId` + 消息 `id` 才全局唯一）。

**fork 与编辑重发的差别**：
- fork：祖先链到目标 entry 为止，之后等用户发新消息。
- 编辑重发：祖先链到被编辑消息的**父节点**为止，接上编辑后的新消息。

验收（纯文件操作，不连 gateway，可完整单测）：
- 构造一个已有分叉的源 transcript，从某个深层 entry fork，产出的祖先链正确（只含该 entry 到根的真实祖先，不含旁支）。
- 截断点落在工具调用中间时，tool_use / tool_result 不被拆开。
- 新分支文件序列化后仍满足 §3「逐行完整 JSON」；来源元数据正确指向父记录。

### 5.1 推理桥接（连 gateway 那一步）

只有**自建会话**走这套流程（活会话是调 `chat.send` 交给 gateway，见 §5、§5.3）。

#### 基本流程（已经实测）
面板要为一条自建会话生成回复时：
1. 调 `sessions.create` 创建一次性临时 session，再覆盖 gateway 为它创建的 transcript。物化内容停在最新用户消息的父节点，也就是上一轮完整 run；最新用户消息不能提前写入。
2. 调 `sessions.send`，将最新用户消息作为 `message` 提交，并带面板生成的 idempotencyKey。
3. gateway 在它自己的 `sessions.json` 里留一个条目——这是推理工作区，面板不把它当权威数据。
4. 等 session 结束后读取临时 transcript 的新增行，校验 gateway 新增的 user entry 与所提交消息一致并跳过它，将后续的**一整组 entry**以原子文件替换方式提交到面板 transcript。**不是只存最后一行，也不把 append 当作事务。**
5. 清理推理工作区（见下方「工作区清理」）。

**必须遵守的约束（否则自动记忆归档会失效）**：推理必须跑在固定的同一个 workspace 下，且保留完整的 prompt 和工具，不要用 `promptMode: none` 或 `minimal` 把 `memory_search` 工具裁掉。原因见方案文档 §5.4。

#### 正确性细节一：一次 run 是一组 entry，整组原子写入（关键原则）
**持久化的单位是「一次 run 产生的一组完整 entry」，不是「一条回复」。** 一次带工具的 run 会依次产生：assistant 思考 → tool_use → tool_result → 可能再一次 assistant/tool_use → 最终 assistant 回复，可能还带 custom 事件和 usage 信息。只存最后一条 assistant 行会导致：UI 看不到工具执行过程、下一轮模型缺少工具调用和结果的上下文、fork 到工具附近时语义不完整、transcript 不再是 OpenClaw 格式的忠实副本。

**这组 entry 从哪来（§0.5 实验第 3 条要回答的）**：先确认 gateway 给客户端的事件是否足够重建这一组 entry；如果不够，则在推理结束后读取临时工作区 transcript 里新增的那几行，复制进面板存储。两条路都要保证拿到的是完整一组，不是只有最后一行。

**状态流与持久化分离**：SSE 只中转 run 生命周期；**面板自己的 transcript 文件在这次 run 结束前一个字都不写。** run 正常结束、拿到完整的一组 entry 后，以临时文件 + fsync + rename 原子替换提交完整 transcript。gateway 后续若提供逐 token 事件，可再扩展 SSE，但不改变提交语义。

这样做的原因：§3 要求 transcript「序列化写回逐行一致」，每行必须是完整 JSON。边流式边写会在崩溃时留下残缺行；一组 entry 若只写了一半（比如写了 tool_use 没写 tool_result）则语义损坏。所以「展示用的流式」与「持久化用的整组写入」分开，文件里永远是完整行、完整组。

#### 正确性细节二：中断与失败的处理
生成过程可能因三种情况中断：用户点停止（`chat.abort` / `sessions.abort`）、gateway 断开、推理自身报错。三种统一这样处理：
- **面板文件层面**：因为遵守细节一（整组 entry 结束后才原子写入），中断时面板存储里那条会话**没有写入这次 run 的任何内容**，保持在中断前「最后一组完整 entry」的干净状态，不需要回滚。
- **界面层面**：把已经流式收到的部分内容留在界面上（不丢弃用户已经看到的字），并明确标注「生成被中断 / 失败」，提供**重试**入口。
- **重试语义**：重试 = 从这条会话的最后一条用户消息重新发起一次推理，等同于「编辑重发」不改内容的特例，复用 §5.0 那套底层，不把这次失败的部分写进文件。
- **可选增强（第一版可不做）**：若希望把中断时已生成的部分也存进历史，须将拿到的那几个 entry 作为**完整 entry**写入（每个仍是完整 JSON），并在这组上带一个 `incomplete: true` 之类的标记，供解析器识别、界面标注。不能写入残缺行或半组。第一版默认不保存中断的部分内容，只保证文件不脏。

#### 正确性细节三：同一会话的并发生成串行化
同一条自建会话，可能有两个浏览器标签同时点「生成」。规则：
- **面板服务端对每条会话维护一把进程内的生成锁**（一个 `Map<sessionId, 队列或忙标志>`）。同一 `sessionId` 的生成请求串行执行：第二个请求要么排队，要么直接被拒绝并提示「该会话正在生成」。第一版用「拒绝 + 提示」最简单，够用。
- 这把锁是面板自己进程内的，够用——因为面板是唯一写自己 transcript 的进程（gateway 只写它自己的 `sessions.json`，见 §5.3 的架构前提）。不存在跨进程争用面板文件的情况。
- 生成完成、失败或中断后释放锁。注意异常路径也要释放（用 try/finally 一类结构），否则一次失败会让这条会话永远卡在「正在生成」。

#### 工作区清理（Owl 已选定）
`sessions.delete` 只注销索引并把 transcript 改名，trajectory 仍会残留。第一版不维护 OpenClaw 补丁，采用以下明确方案：

1. 每个真实 agent 对应一个无渠道绑定的专用 runtime agent。两者共用目标 workspace，但 sessions 目录隔离。
2. 每轮先调用官方 `sessions.delete` 注销。
3. 再只在该 runtime agent 的 allowlist sessions 根目录内，按本轮服务端创建并登记的 sessionId 删除当前 OpenClaw 版本已验证的 transcript 归档和 trajectory artifacts。
4. 清理拒绝符号链接、路径越界、未知文件类型和非 allowlist 根目录；绝不清理真实 agent 的 sessions 目录。
5. 第一版仅支持 OpenClaw `2026.6.11`。版本不符时拒绝推理和清理，升级后先重跑兼容实验。

### 5.2 连接 gateway 的方式

- 通过 localhost WebSocket 连 `127.0.0.1:18789`。
- 握手用 operator 角色 + token（`gateway.auth.token`）。**不需要设备身份签名**（operator + token 通过后可跳过，依据见方案文档 §4.4）。
- 连接 `client` 字段的具体填法见 §7 待实测项。

验收（连 gateway 的部分，跑在测试 agent 上）：
- 能成功握手连上 gateway，不报设备身份错误。
- 发一条测试消息，能拿到模型回复（证明推理桥接通）。
- 确认这条测试消息**没有**发到任何 IM（因为测试 agent 没绑渠道）。
- 推理用过的 gateway 工作区会话，事后被正确清理。

### 5.3 向活会话发送消息的安全边界 ⚠️

**首版结论：不开放这条写链路。**真实 active 会话与 reset 归档只读；以下内容仅作为未来版本风险依据，不是首版待验收功能。

面板往**活会话**（绑定 IM 的会话）发消息，是调 gateway `chat.send`，让 gateway 追加到同一个上下文桶。这一步对真实 agent 有不可逆的外部影响：

- gateway 生成的回复会按会话记录里的 `route` / `deliveryContext` 投递，**很可能同时发到 Owl 真实的 Telegram / 飞书**，且发出即不可撤回。
- 因此这条链路只能这样验证：
  - 测试 agent `paneltest` 没绑任何渠道，向它的活会话发送不会漏出去——**发送逻辑本身在 `paneltest` 上验**。
  - 面板对真实 agent（`claude`、`main`）的**读、刷新、界面、多 agent 切换**可以无人时自主验证（只读、无外部影响）。
  - 面板**向真实 agent 的活会话发送并生成回复**，必须等 Owl 在场时验证，不在无人时段做。
- 这条写进 §6 分段：多 agent 的读与界面归第二段（可在真实 agent 上验读），向真实活会话发送归第三段（等 Owl）。

### 5.4 OpenClaw 自带命令

**v1 现状（保留，不回退）**：普通消息发送路径拒绝一切以 `/` 开头的输入，服务端在 bridge 之前以稳定错误码 `SLASH_COMMANDS_UNSUPPORTED` 拒绝，不写 transcript、不调用 gateway。完整分类适配设计、机制发现与源码依据见 [`decisions/slash-commands.md`](decisions/slash-commands.md)。

**适配实现规格（首版做 A + C 两类）**

核心安全不变量（违反即等于把 admin 权限暴露给误输入）：
- **两条路径彻底隔离**：普通消息发送接口**永远拒绝 `/`**；命令**只从独立命令派发接口进入**（如 `POST /api/v1/sessions/<id>/command`，请求体是结构化的 `{ command, args }`，不是自由文本）。
- **绝不把命令字符串带内塞进推理桥接的 `sessions.send`**（gateway 会把它当命令并以当前 admin scope 自动授权执行）。命令效果一律经面板原生操作或专用 typed RPC 实现。

| 类 | 首版 | 实现 |
|---|---|---|
| A 面板原生（`/model` `/think` `/reasoning` `/new`） | ✅ | 写入面板会话 metadata（`modelOverride` / `thinkingLevel` 等）；下轮推理经 `sessions.create` 参数或 `sessions.patch` 应用到临时 session。`/new` 复用新建面板会话。与 §8.6「会话中途换模型」同一实现。**逐命令参数语义见下表。** |
| B `/compact` | 归 §22 长上下文 | 物化历史后调 **`sessions.compact` typed RPC**（绝不把 `/compact` 送进 `sessions.send`）、读回压缩后 transcript、采纳进面板存储。不在本节单独实现。 |
| C 信息类 | 首批 `/help` `/commands` `/status` `/models`；其余待侦察 | 调已核实的只读 RPC/CLI 或基于 allowlist 生成，面板渲染，不产生写入。`/tools` `/usage` 在来源和 DTO 核实前不进入 allowlist。 |
| D gateway 管理 / owner 全局（`/config` `/restart` `/reset` `/mcp` `/plugins`） | ❌ 默认不做 | 面板不暴露入口；用户在原生 surface 执行。 |
| `/bash`（未来可能的面板原生能力，非命令代理） | ❌ 当前不做 | gateway 无命令执行 RPC。当前不设启用开关、不进 allowlist，派发一律拒绝；未来立项前先完成 §5.6。 |

**命令补全与支持范围（allowlist 定位）**：客户端在输入框敲 `/` 时拉 `commands.list`（含 skill/plugin 动态命令）+ 面板原生命令做补全。**关键区分**：
- `commands.list` **仅用于补全展示与参数提示**（命令名、描述、参数 schema），不代表面板会执行它。
- 面板实际支持的命令，是一份**显式、版本化、默认拒绝（default-deny）的服务端 allowlist**（首批 = A 类 + `/commands` `/help` `/status` `/models`；`/bash` 不在本批）。补全列表里出现但不在 allowlist 的命令（如 `/skill`、`/goal`、`/tasks`、`/approve`、`/export-session` 等）在客户端灰显并标注「仅 OpenClaw 原生渠道可用」，不发请求；服务端仍以稳定错误码拒绝手工构造的请求。
- **OpenClaw 升级新增命令时默认拒绝**，不因出现在 `commands.list` 而自动获得执行入口——新增命令要显式评审归类后才进 allowlist（见 engineering-decisions「版本控制与升级维护」）。这条是安全面不随上游漂移的保证。
- `commands.list` 不返回 owner/surface/run 可用性，这三类由面板按分类判断或派发时由 gateway 执行层裁决。

**A 类逐命令参数语义**（首版；写面板会话 metadata，下轮推理经 `sessions.create`/`sessions.patch` 应用）：

| 命令 | 无参数时 | 有参数 | 值校验 | 恢复默认 | 生效时机 |
|---|---|---|---|---|---|
| `/model [m]` | 返回当前 override + 可选模型列表，不报错 | 写 `modelOverride` | 目录来源固定为服务端执行 `openclaw models list --json`；只接受 `available=true` 的规范 `key`，别名须先解析成该 key | `/model default` 清除 → 删除 `modelOverride`，回 agent 默认 | 写 metadata 即时生效，作用于**下一轮**推理（不影响进行中的 run） |
| `/think [level]` | 返回当前 `thinkingLevel` + 可选值 | 写 `thinkingLevel` | 值须在 gateway 支持集内；当前模型不支持该 level 时**派发即拒绝并回报原因**，不静默降级 | `/think default` 清除 → 回默认 | 同上，下一轮生效 |
| `/reasoning [mode]` | 返回当前 `reasoningLevel` 与 `on/off/stream` 三个可选值 | 写独立的 `reasoningLevel`，它控制思考内容可见性，**不是** `/think` 的别名 | 仅接受 `on`、`off`、`stream`（来自 2026.6.11 `commands.list` / `sessions.patch` schema） | `/reasoning default` 删除 `reasoningLevel`，回 agent 默认 | 同上 |
| `/new` | **新建面板会话**（不是改当前会话 metadata） | 可带初始标题 | — | — | 立即创建，返回新 `recordId`，客户端切换到新会话 |

- A 类命令**是否写入 transcript**：写一条 `custom`/`model_change` 类系统事件进面板 transcript（UI 显示为一条系统提示），使「本轮用了哪个模型/思考档」在历史里可见且随 fork 继承。`/new` 例外——它创建新会话，不往当前会话写事件。
- **并发生成期间**：run 进行中时 A 类设置类命令入队到该轮结束后应用（或提示「生成中，稍后生效」），不中断进行中的 run；`/new` 不受影响。

**C 类逐命令来源与语义差异**（只读，`operator.read`，不写入）：

| 命令 | 数据来源 | 与原生命令的已接受差异 |
|---|---|---|
| `/commands` | `commands.list` 直接渲染 | 无实质差异；面板可额外标注哪些在 allowlist 内可执行 |
| `/help` | 面板基于 allowlist + `commands.list` 描述**自行生成** | 展示的是**面板支持范围**的帮助，不是 gateway 原生 `/help` 全文 |
| `/status` | gateway `status` RPC | `status` 是**全局运行状态**，不等价于原生某 session 内 `/status`；面板明示这是 gateway 全局状态 |
| `/models` | 服务端执行 `openclaw models list --json`；响应取 `models[].{key,name,input,contextWindow,available,tags,missing}` | 这是 OpenClaw CLI 的配置可见模型目录，不是 session 内原生 `/models` 文本；只读、不改配置。因 `/model` 校验也依赖同一目录，纳入首批 C |
| `/tools`（待侦察） | 尚未确定；`commands.list` 不提供当前 runtime 工具上下文 | 同上；不得把面板猜测的工具清单冒充 gateway 真实值 |
| `/usage`（待侦察） | 尚未确定；需先决定展示 gateway 计量还是面板 transcript 估算 | 同上；若最终采用估算，命令名和 UI 必须明确标注「估算」 |

> `/commands`、`/help`、`/status`、`/models` 的来源已确定，可作为首批实现。`/tools`、`/usage` 是单独的侦察任务：必须先把具体 RPC/本地来源、参数、返回 DTO、与原生命令的差异补进本表并提交评审，之后才能加入 allowlist，不能由实现者边写边猜。

验收：
- 普通消息接口提交 `/` 开头文本仍返回 `SLASH_COMMANDS_UNSUPPORTED`，不调用 gateway、不写 transcript（回归 v1 行为，不因新增命令派发路径而松动）。
- A 类：对面板会话设 `/model X` 后，metadata 记录 override；下一轮推理确实以该模型跑（在 `paneltest` 验），且该设置**不因临时 session 删除而丢失**（因为存在面板 metadata，不在临时 session）。
- C 类：`/commands`、`/status` 返回 gateway 的真实数据，`/models` 返回 `openclaw models list --json` 的规范 DTO；这些操作只读，不产生配置写入或 transcript 变更。
- **allowlist 默认拒绝**：补全列表里出现但不在 allowlist 的命令灰显且客户端不派发；手工构造 `/skill`、`/goal`、升级后未知命令等请求时，服务端以稳定错误码拒绝且不产生副作用。
- D 类命令在面板无入口；即便手工构造派发请求，服务端也拒绝。
- `/bash` 当前不在 allowlist，派发始终被拒绝；未来立项不属于本批验收（见 §5.6）。
- 安全回归：命令派发接口同样受同源检查 / CSRF 保护与登录态约束（见安全基线）；命令字符串在任何路径下都不会进入推理桥接的 `sessions.send`。

### 5.5 面板记忆系统（控制层打底，按需喂原生 promote）

设计依据与 OpenClaw 记忆机制的源码结论见 [`decisions/panel-memory.md`](decisions/panel-memory.md)。核心事实：OpenClaw 记忆归档只认 `workspaceDir` 维度，而 `panel-runtime-<agent>` 与真实 agent **共用 workspace**。这带来一缺口 + 一风险：面板会话新内容基本进不了 `MEMORY.md`；同时面板推理（保留了 `memory_search`）的召回信号会进共用 store，调试噪音有渗入真实记忆的通路。

**首版只做控制层（路线 C）：**
- 每条面板会话带 `memoryDisposition`：`eligible`（可进记忆）或 `scratch`（草稿/调试，不得渗入记忆）。
- **默认值 `scratch`**（Owl 2026-07-12 定，见 `decisions/panel-memory.md`）：新建 / fork 面板会话默认不进记忆，想沉淀的会话由用户手动标 `eligible`。
- `scratch` 会话的推理必须收窄记忆副作用。收窄方式需在实现时于 `paneltest` 实测确认，二选一或组合：
  1. 该轮推理不装配 `memory_search`/`memory_get`（注意：这会与 2a′「保留完整工具」的约束冲突，仅对显式标 `scratch` 的会话生效，且不影响 `eligible` 会话的记忆归档）；
  2. 或让 `scratch` 会话在**独立的一次性 workspace** 下推理，与真实 agent 的共用 workspace 隔离，从 key 层面切断渗入。
- 方式 2 更彻底（记忆机制只认 workspace key，换 workspace 即换 store），但会失去共用 workspace 的记忆注入；方式 1 保留注入但依赖“少调用 memory_search”这一较弱保证。实现时以实测结果择一，记进代码注释与 `decisions/panel-memory.md`。

**按需叠路线 B（首版可不做，接口预留）：** 把 `eligible` 会话中该沉淀的内容，以 OpenClaw 认得的形式写入共用 workspace 的短期记忆文件（如 `memory/YYYY-MM-DD.md`），让原生 cron sweep + promote 接手，不在面板复刻 promote 逻辑。触发时机（是否每天定时、扫哪些 `eligible` 会话、如何避免与 gateway 并发写同一记忆文件）留待路线 B 正式立项时定。

**约束：** 面板绝不直接编辑 `MEMORY.md` / `DREAMS.md`（那是 OpenClaw promote 的产物，并发写会与 cron 冲突）。路线 B 若做，只写“喂料”的短期记忆文件，promote 仍由 OpenClaw 执行。

验收（控制层部分，可在 `paneltest` 验）：
- 会话可标记 `eligible` / `scratch`，状态持久化（同 §4.3）。
- 对 `scratch` 会话跑一次受控推理后，按所选收窄方式验证：方式 1—该轮无 `memory_search` 装配；方式 2—recall store 的 workspace key 与真实共用 workspace 不同（换了 workspace）。
- 对 `eligible` 会话，记忆注入与 `memory_search` 行为与默认 2a′ 一致（不因本功能退化）。

### 5.6 `/bash`：未来可能的面板原生进程执行（仅立项检查清单，当前不实现）

`/bash` 是**面板原生能力**而非 gateway 命令代理。下列内容目前只是立项前的安全检查清单，**不是完整实施规格**；所有数值和执行语义落定前不进入实现批次。默认行为只有一条：`/bash` 不在 allowlist，派发请求被拒绝。

未来立项前提：
- 当前版本不读取 `PANEL_ENABLE_BASH`，避免一个看似可用但安全语义未定的开关；服务端稳定拒绝 `/bash`。
- 未来若增加开关，开启但登录未启用（或登录强度未达安全基线）时，服务必须拒绝启动。

执行模型（未来立项时逐条定死并测试）：
- **先决定能力类型**：若采用 `spawn(executable, args, { shell: false })`，这是结构化进程执行器，不支持管道、重定向等 shell 语法；若采用 shell 文本，则参数数组不能提供“防注入”保证，必须另做完整威胁模型。两者不得混称。
- **cwd**：默认工作目录、是否允许 per-command 指定 cwd 及其边界校验均须明确（沿用 §0 路径/符号链接防护，拒绝越界）。
- **环境变量**：传入子进程的 env 白名单；**绝不泄漏面板自身的密钥 / 口令哈希 / 会话密钥**给子进程。
- **超时**：单条命令墙钟超时，到点强制终止。
- **输出上限**：stdout/stderr 字节上界，超限截断并标注（沿用「不静默截断」——要显式告知被截断）。
- **进程终止**：用户可中断正在跑的命令（复用停止生成的 abort 通道或独立 kill）。
- **并发上限**：同时运行的 `/bash` 进程数上限，防止耗尽资源。
- **参数编码 / 防注入**：若选择结构化进程执行器，使用 `{ executable, args[] }` 并以 `shell:false` 启动，绝不拼接 shell 字符串；若未来明确需要 shell 语法，本条作废并重新评审。
- **审计日志**：每条 `/bash` 记录时间、命令、退出码、是否被截断 / 超时 / 中断，写独立审计日志。

明确接受的权衡：一旦开启，「面板登录失守」在后果上等同于「shell 访问」。因此登录强度（慢哈希口令、限速、SameSite=Strict cookie、仅 localhost 监听 + SSH 隧道）是**开启 bash 的前提**，不是可选项。

验收（`/bash` 若实现）：
- 未开启时，`/bash` 派发被拒绝，返回稳定错误码。
- 开启但登录未启用时，服务拒绝启动。
- 开启且登录启用时：命令以数组参数执行（构造含 shell 元字符的参数不发生注入）；超时命令被终止；超限输出被截断并标注；审计日志记录每条执行。
- 子进程 env 不含面板口令哈希 / 会话密钥。

---

## 6. 开发分段（决定哪些能在无人时做，哪些等 Owl）

### 第 0 段：桥接可行性实验（已完成，见 §0.5）
实验已经产出 `实测记录.md`，Owl 已确认继续采用 2a′ 和专用 runtime agent 清理方案。

**第 0 段与第一段可以并行**：第一段是不依赖这座桥的纯本地工作，实验跑的同时可以推进；但第一段里凡涉及「一次 run 如何搬回面板」的**数据模型定稿，要等第 0 段实验第 3 条的结论**，不要在实验出结果前把 entry 存储格式定死。

### 第一段：整夜可自主完成（不连 gateway、可逆、可自测）
按顺序做，每步做完自测通过再进下一步：
1. 一页**工程决定**文档（见 §6 末尾「工程决定」），把技术选型、目录、错误码、索引原子写等先写清楚。
2. 项目骨架：Node 服务端 + 前端脚手架，一个能起来的空壳。**从第一天就带上安全基线（见 §6 末尾「安全基线」），不要留到登录那步再补。**
3. §3 transcript 解析器 + 序列化（**保留全部 content block 类型**：tool_use / tool_result / 思考块），单元测试。
4. §4 会话索引 + 导入会话（活会话只读源文件、reset 归档快照、多 agent 分别扫描；索引可从磁盘全量重建），单元测试。
5. §5.0 fork / 编辑重发的**文件层底层函数**（沿 parentId 回溯祖先链、tool 组不拆开），单元测试。纯本地文件操作，能完整自测。
6. 侧边栏列表 + 搜索 + 多 agent 切换（联系人页）UI。
7. §8 界面：claude.ai 风格暖色调、会话视图、消息树、工具调用/思考块可折叠、响应式适配多屏。
8. 失败与中断状态的本地部分（见 §8.4）：transcript 里生成中断/失败留成什么样、界面怎么呈现、能否重试，先把不连 gateway 能定的部分做掉。

这一段占工作量大头，全部能自己验收，可以整夜推进。

### 第二段：连测试 agent 验证；真实 agent 只验读
9. §5.2 连接 gateway，§5.1 推理桥接，接到测试 agent `paneltest` 上跑通（以第 0 段实验的结论为基础）。
10. 停止生成、SSE 生命周期状态与断线 abort；逐 token 输出留待 gateway 能力确认。
11. fork / 编辑重发接上真实推理（在 `paneltest` 上验证整条链路）。
12. **斜杠命令（见 §5.4）**：普通消息路径永久拒绝 `/`（保留客户端与服务端双重拒绝测试）；命令走独立派发接口，下一批做 A（面板原生）+ 首批 C（只读信息类），按 default-deny allowlist 校验。`/compact` 归 §22 长上下文（经 `sessions.compact` typed RPC），`/reset` 等 D 类默认不做，`/bash` 当前不实现。
13. **长对话上下文策略的接口（第一版已实现）**：2a′ 里每次推理的历史都由面板提供，「历史里放哪些内容」本身就是推理适配层的接口。当前在调用 gateway 前，以 `utf8-bytes-upper-bound-v2` 将完整 transcript 与本轮消息的 UTF-8 字节数作为 token 上界；默认历史预算 100000 tokens，可配置。超限返回 `CONTEXT_BUDGET_EXCEEDED`，不调用 gateway、不写本轮消息，并提示从较早位置 fork。第一版不静默截断、不伪造自动摘要。精确 tokenizer、压缩后的摘要 entry、fork 穿过摘要边界、工具结果和思考如何进入摘要，仍留待完整压缩策略确定。
14. 多 agent 对真实 agent（`claude`、`main`）的**读、刷新、界面、切换**——只读、无外部影响，可在此段自主验证。

第二段**只对 `paneltest` 验证"发送和生成"**；对真实 agent 只做只读验证，**不向真实 agent 的活会话发送消息**。

### 第三段：必须等 Owl 醒着
15. **移出首版：**不向真实 agent（`claude`、`main`）的活会话发送消息；未来若重新立项，必须由 Owl 在场并重新评估真实 IM 投递风险。
16. 登录 / 登录态：账号密码（Owl 已定，纯本地一层，实现从简）。
17. 长对话上下文管理的**完整策略**（在第 13 项接口之上，定压缩时机、摘要方式、是否触发记忆归档——牵涉产品判断）。
18. 部署、端口、SSH 转发联调；git-crypt 数据目录加密（见方案 §二「数据保护」）。

### 首版之后的路线（v1 已部署并在用，以下为 2026-07-12 追加）

上面三段是首版的自主开发计划，已完成。以下是首版之后的增量，按 Owl 定的顺序推进。

**排序决定（重要）：斜杠命令 → 长上下文，记忆功能插在中间。**
理由：部分斜杠命令（如 `/compact`）本身就会改变上下文，且这些都是 gateway 在做。面板应先兼容它们的行为——活会话的压缩交给 gateway、如实读它压缩后的 transcript——之后再处理面板自建会话的长上下文，就有 gateway 行为可参照，更自然。
⚠️ 但要记住：`/compact` 只解决**活会话**。面板自建/fork 会话是 2a′ 下面板自己物化历史喂给 gateway 的，压缩前 flush 永远触发不了（见方案 §5.4），这部分长上下文最终仍由面板自己承担。斜杠命令不会替它兜底。

按顺序：

19. **纯本地增量（不连 gateway，可随时做，与排序无关）：**
    - §8.7 Markdown 渲染 + 消息复制 + 代码块复制。（已实现：纯 DOM 安全渲染，原始 HTML 不执行。）
    - 消息时间戳 UI 显示（读 entry `timestamp`，本地时区）。（已实现。）
    - §4.3 会话重命名 / 归档 / 取消归档 / 删除（面板会话彻底删除、只读会话仅隐藏）。（已实现重命名、归档与取消归档；隐藏和彻底删除留待下一批。）
    - §5.5 记忆倾向标记的**存储与 UI**（打标本身不连 gateway）。
20. **记忆控制层的推理侧（连 gateway，`paneltest` 验）：** §5.5 `scratch` 会话的记忆副作用收窄，二选一实测确认。
21. **斜杠命令适配（A + 首批 C）：** 按 [`decisions/slash-commands.md`](decisions/slash-commands.md) 的分类适配设计与 §5.4 实现规格。守住两条路径隔离的安全不变量（普通消息路径拒绝 `/`，命令只走独立结构化派发接口，命令字符串绝不带内进 `sessions.send`）。
    - A 面板原生（`/model` `/think` `/reasoning` `/new`）：写面板会话 metadata，推理时应用；与 §8.6 换模型同一实现。
    - 首批 C 信息类为 `/commands`、`/help`、`/status`、`/models`；`/tools`、`/usage` 先完成来源与 DTO 侦察，再另行加入 allowlist。
    - `/` 补全拉 `commands.list`（含 skill/plugin 动态命令）。
    - B `/compact` 归第 22 项；D 类默认不做；`/bash` 当前不实现，也不提供启用开关。
22. **长上下文完整策略（含 B 类 `/compact`）：** 在第 21 项之后。活会话压缩交给 gateway；**面板自建会话的 `/compact` 与长上下文压缩是同一份工作**——物化临时 session 后调用 `sessions.compact` typed RPC，读回压缩后的 transcript 并采纳进面板存储，绝不把 `/compact` 送进 `sessions.send`。需定：压缩时机、摘要 entry、fork 穿越摘要边界、压缩点是否触发一次侧重 `memory_search` 的推理以补记忆归档。这也是记忆路线 B「按需喂 promote」可能落地的点。
23. **按需增量（记录、不排期）：** 会话置顶、导出会话为 Markdown、附件/多模态输入、草稿（仅浏览器本地）。
24. **持续维护：** OpenClaw 版本升级适配，见工程决定「版本控制与升级维护」。

---

### 安全基线（第一天起就要有，不等登录那步）
- 面板服务端**只监听 `127.0.0.1`**，不对外暴露端口（外部靠 SSH 转发）。
- gateway token **绝不下发到浏览器、绝不写进日志**。
- **日志默认不记录消息正文和提示词**（会话内容和记忆一样敏感）。
- 所有修改类接口要有 CSRF 防护或严格同源检查。
- 登录做了之后：密码用慢哈希（如 argon2/bcrypt）保存、不进仓库；cookie 设 `HttpOnly` + `SameSite=Strict`；登录尝试限速。
- **不接受客户端传任意路径**：agent 用 allowlist，会话文件路径由服务端从 agentId + recordId 推导，防目录穿越和符号链接绕过。
- 测试夹具必须脱敏（见 §0 约束 7 的工具副作用控制）。

### 工程决定（开工前补一页，避免边写边返工）
先写清楚再动手，内容至少覆盖：
- Node 版本、包管理器、是否用 TypeScript。
- 服务端框架、前端框架。
- API 路由风格；流式用 SSE，约定事件格式。
- 数据目录的配置方式（环境变量 / 配置文件）。
- 错误码和错误响应格式。
- **`index.json` 只作可重建缓存**：写入用「临时文件 + fsync + 原子改名」；能从扫描 transcript 全量重建；fork 来源等权威元数据进 transcript 头或独立可重建的元数据文件，不只存索引。
- OpenClaw 版本兼容范围，启动时做版本检查（打包源码路径、RPC 名称都可能随版本变）。
- 备份、恢复、迁移怎么验收。

## 7. 实现时需要继续实测的兼容细节

这些是侦察没有查到底、但实现时一试便知的细节。Codex 遇到时先在测试 agent 上实测，把结果记进代码注释或一个 `实测记录.md`：

1. **已确认：推理 RPC** 使用 `sessions.create` 登记一次性 session，再覆盖 transcript，并用 `sessions.send` 提交最新用户消息。实现时只需把复现脚本中的参数收束进适配层。
2. **connect 握手的 `client` 字段**：`client.id` 和 `client.mode` 填什么能以 operator 角色连上并跳过设备签名。参考：operator 角色 + token 通过即可跳过。
3. **`resolveContextInjectionMode` 的行为**：确认 `SOUL/USER/MEMORY` 等文件在面板发起的推理里确实被注入（发一条能触发记忆的测试消息，看回复是否体现）。
4. **`memory_search` 的 recall 落盘**：跑一次推理后，确认测试 workspace 的 recall store 有新数据写入（验证自动记忆归档的前提成立）。
5. **browser / canvas / skills 等工具**是否随推理自动带上。
6. **后续实测逐 token 能力**：首版已经按整组完成结果实现 SSE 生命周期；只有 gateway 将来提供稳定 token 事件时才扩展逐 token 展示。
7. **命令兼容侦察**：首批实现来源已核实的 `/commands`、`/help`、`/status`、`/models`。`/tools`、`/usage` 的数据来源、参数和返回 DTO 作为独立侦察任务；结论先更新 §5.4，再扩展 default-deny allowlist。命令字符串始终不进入 gateway 官方带内分派。

---

## 8. 界面规格（方向由 Owl 定，Codex 照此搭第一版）

界面的"顺不顺眼、暖色调对不对味"没有测试能判定，属于 Owl 醒后要亲眼调的部分。本节给定信息架构、组件清单和配色间距的**方向**，Codex 按此搭出第一版；具体色值、最终观感留给 Owl 微调。样式可参考 claude.ai，但不照搬。

### 8.1 信息架构（三栏）

```
┌──────────┬───────────────────────┬─────────────────────────────┐
│ Agent 栏  │  会话列表（侧边栏）      │  会话主视图                    │
│ (联系人)  │                        │                             │
│          │  [＋ 新建会话]          │  ┌─────────────────────────┐ │
│ ● claude │  🔍 搜索…               │  │ 会话标题      · fork 自 XX │ │
│ ○ main   │  ─────────────         │  └─────────────────────────┘ │
│ ○ panel- │  ▸ 会话 A      · 未读   │                             │
│   test   │    昨天 · 12 条          │  用户: ……                    │
│          │  ▸ 会话 B（fork）       │  ┌─ ▸ 工具调用（折叠）──────┐  │
│          │    3 天前 · 8 条         │  └────────────────────────┘  │
│          │  ▸ 会话 C（reset 归档） │  Claude: ……      [从这里 fork] │
│          │    ……                   │  ┌─ ▸ 思考过程（折叠）──────┐  │
│          │                        │  └────────────────────────┘  │
│          │                        │  ─────────────────────────   │
│          │                        │  [ 输入框 ]                   │
│          │                        │  [发送] [停止]                │
└──────────┴───────────────────────┴─────────────────────────────┘
```

- **最左 Agent 栏（联系人页）**：列出各 agent（`claude` / `main` / `paneltest`），当前选中高亮。切换 agent 换掉中间的会话列表。有新消息的 agent 标未读点。
- **中间会话列表**：顶部"新建会话"+ 搜索框。每条会话显示标题、更新时间、消息数；fork 出来的标"fork 自 XX"，reset 归档的标"归档"。有未读的标未读点。
- **右侧主视图**：消息按时间流排列。用户消息、模型回复区分样式，assistant 回复按 Markdown 渲染。每条消息显示本地时区时间戳。工具调用、思考块默认折叠、点击展开。每个消息节点悬停出现"从这里 fork"、"编辑"、"复制"。底部输入框、发送 / 停止按钮；首版不提供命令菜单，以 `/` 开头的输入会被拒绝（见 §5.4）。

### 8.2 组件清单
- AgentList（联系人栏）、AgentItem（含未读点）
- SessionList、SessionItem（标题 / 时间 / 消息数 / fork 或归档标记 / 未读点）、SearchBox、NewSessionButton
- SessionListTabs 或等价切换：主列表 / 归档列表两个视图
- SessionMenu（每条会话的操作：重命名、归档 / 取消归档、彻底删除仅面板会话且需二次确认、记忆倾向切换）
- ConversationView、MessageBubble（user / assistant 两态）
- MessageContent：Markdown 安全渲染（含 CodeBlock，每块带单独复制按钮）
- MessageTimestamp（本地时区日期时间）
- CollapsibleBlock（工具调用、思考块共用，默认折叠）
- MessageActions（悬停出现：从这里 fork、编辑、复制整条消息）
- Composer（输入框 + 发送 / 停止；首版无命令菜单，见 §5.4）
- StreamingIndicator（流式生成中的光标 / 加载态）
- LoginForm（账号密码）

### 8.3 配色与间距方向
- **暖色调**：以米白 / 暖灰为背景，避免纯白纯黑；强调色用暖橙或赭色一类，接近 claude.ai 的观感。
- 具体色值 Codex 先给一版接近的，Owl 醒后调。用 CSS 变量集中管理颜色，方便一处改全局（回应 ClawGPT"主题难改"的痛点）。
- 间距宽松、留白充足；正文行高偏松，长文易读。
- 字体优先系统字体栈；代码块和工具调用用等宽字体。

### 8.4 失败与中断状态（正确性相关，先想清楚再实现）
- **生成中断 / 失败**（推理挂了、gateway 断开、用户点停止）：这一条消息在 transcript 里要留成可识别的状态（例如标记为 incomplete），不能留下半条脏数据破坏解析。界面上明确显示"生成被中断 / 失败"，并提供**重试**。
- **重试**：重试是从该消息的父节点重新生成，等同一次编辑重发，复用同一套底层。
- **连接断开**：面板↔gateway 断开时，界面给出可见提示，不静默失败。
- 不连 gateway 能定的部分（transcript 里怎么标、界面怎么显示、重试入口）归第一段先做；连 gateway 才能验的部分（真中断一次看状态对不对）归第二段在 `paneltest` 上验。

### 8.5 响应式（多屏是硬需求）
- 桌面（Windows / Linux）：三栏并排。
- 窄屏（手机）：三栏折叠为可切换的层级——Agent 栏和会话列表收进抽屉 / 返回式导航，主视图占满。消息树在窄屏下纵向展开，工具调用 / 思考块仍可折叠。

### 8.6 优先级较低（第一版可后放）
- **一个会话中途切换模型 / 供应商**：transcript 有 `model_change` 条目。此能力依赖 gateway，**随斜杠命令适配到位即可获得，面板不自建**（见 §一「暂不实现」与 §5.4）。接口先留出。
- **面板作为渠道注入自己的系统提示**：回应"每渠道注入 prompt"的需求。第一版可不做，记为后续。

### 8.7 Markdown 渲染与复制（新增 2026-07-12）

- **Markdown 渲染**：assistant 回复文本按 Markdown 渲染——标题、粗体/斜体、有序/无序列表、代码块（行内与围栏）、表格、链接、引用、分隔线等常见语法。用户消息可保留纯文本或轻量渲染（Owl 微调）。
- **安全第一**：渲染必须走安全 DOM，禁止执行任意 HTML / 脚本，链接不自动跳转到危险协议。这与 §6.4 工具调用/思考块的安全渲染是同一条硬要求（v1 已有安全 DOM 渲染，MD 渲染沿用同一管线，不新开不受信任的 `innerHTML` 路径）。选库时优先选默认转义、可配置 allowlist 的方案；若库自带代码高亮与复制按钮，可直接复用。
- **整条消息复制**：每条 assistant 消息（也可扩展到 user 消息）提供“复制”动作，复制原始 Markdown 文本到剪贴板（不是渲染后的 HTML），便于粘贴他处仍是 Markdown。
- **代码块单独复制**：每个围栏代码块右上角提供复制按钮，复制该块原始代码。很多 Markdown / 高亮库自带此能力，优先复用。
- **代码块样式**：等宽字体，语言标签可选显示，长代码横向滚动不撑破布局（回应 v1 已修的 `constrain conversation layout`）。

验收（纯本地，可完整自测）：
- 用含各类语法（含嵌套列表、表格、多语言代码块）的样本消息渲染，视觉正确、无布局溢出。
- 构造含 `<script>`、`onerror=`、`javascript:` 链接的恶意 Markdown 样本，渲染后不执行、不产生可点击的危险协议链接（安全回归测试）。
- 复制整条消息得到的是原始 Markdown 文本；复制代码块得到的是该块原始代码。

---

## 9. 给 Codex 的工作方式建议

- 用任务清单管理进度，每完成一项标记，并记下自测结果。
- 遇到 §0 任何约束无法保证、或 §7 实测结果与本规格矛盾时，停下并在清单里写清楚问题，转去做其它不受影响的任务，等 Owl 醒来。
- 每个 commit 只包含一件事，commit message 说清做了什么、自测是否通过。不要 push。
- 代码风格、命名跟随你建立的项目约定，保持一致。
