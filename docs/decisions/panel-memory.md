# 面板记忆模块决定

日期：2026-07-12
修订：2026-07-21

## 结论

面板把「使用既有记忆」与「让当前会话贡献新记忆」分成两个独立概念：

1. **所有面板会话都读取既有记忆。** `scratch` 与 `eligible` 均使用目标 agent 的真实 workspace、bootstrap 记忆和 `memory_search` / `memory_get`，不得因为会话不沉淀而让 agent 失去连续性。
2. **`memoryDisposition` 只控制当前会话能否进入面板管理的记忆沉淀流程。** `scratch` 不会被面板提炼、写入或定时整理；只有 `eligible` 才能产生候选记忆。
3. **新内容通过可审阅的短期记忆文件进入 OpenClaw。** 首版先由用户手动发起整理、预览并确认，面板再写入唯一的 `memory/YYYY-MM-DD-ark-panel-<batch>.md`；不直接编辑 `MEMORY.md` 或 `DREAMS.md`。
4. **先提供只读记忆中心，再考虑自动整理。** 用户可以查看 OpenClaw 识别的记忆文件和面板贡献的来源；在线编辑、定时自动确认与长期记忆回滚不属于首个实现批次。

这次修订推翻旧版「`scratch` 不装配记忆工具或改用无记忆 workspace」的决定。该做法会让草稿会话中的 agent 不认识用户，而且 OpenClaw `2026.6.11` 的普通 session 也不支持按单次请求设置工具 deny。

## 三个不同的概念

| 概念 | 含义 | 首版行为 |
|---|---|---|
| 记忆读取 | 模型使用 `MEMORY.md`、近日记忆和记忆搜索回答当前问题 | `scratch`、`eligible` 都开启 |
| 会话处置 | 用户是否允许面板从这条会话提炼新记忆 | 每会话 `scratch` / `eligible`，默认 `scratch` |
| 记忆沉淀 | 把尚未整理的对话提炼成短期记忆文件，交给 OpenClaw 索引和后续 promote | 仅 `eligible`；首版手动、预览后确认 |

`eligible` 的含义是「允许整理」，不是「每条消息自动写记忆」；`scratch` 的含义是「不进入面板的沉淀管线」，不是「禁用已有记忆」。

## OpenClaw `2026.6.11` 的实证边界

- `MEMORY.md` 是精炼的长期层；`memory/YYYY-MM-DD.md` 和 `memory/YYYY-MM-DD-<slug>.md` 是详细的短期/每日层。内置 memory engine 会索引 `MEMORY.md` 与 `memory/**/*.md`，文件变化会触发延迟重建索引。
- `panel-runtime-<agent>` 与目标 agent 共用 workspace，因此正常面板推理可以获得相同的记忆文件和记忆工具。它们的 runtime session 目录仍然隔离。
- 面板权威 transcript 在 `PANEL_DATA_DIR`，不在 OpenClaw 的长期会话目录中；每轮推理的临时 runtime session 又会在完成后清理。因此不能依靠偶然的 transcript sweep 或压缩前 flush，把面板新内容稳定变成记忆。
- `sessions.patch` 虽暴露 `inheritedToolAllow` / `inheritedToolDeny`，但源码明确只允许 `subagent:*` 或 `acp:*` session。普通面板临时 session 不能借此只移除 `memory_search` / `memory_get`。
- `memory_search` 会读取旧记忆，并可能留下查询、召回或强化统计供 OpenClaw 的记忆流程使用。这不是把当前会话正文写成新记忆，但也意味着「读取记忆」不能诚实地宣称为内部状态字节级零变化。
- OpenClaw 的 dreaming 默认关闭；启用后可能读取短期记忆、召回轨迹以及可用的已脱敏 session transcript。面板不能把临时 runtime transcript 的竞态摄取当成合法沉淀路径。每次受支持版本升级，以及启用 dreaming 前，都必须在隔离环境验收 scratch 会话正文不会通过临时 session 被摄取。

## 会话处置规则

每条会话保留现有 `memoryDisposition`：

| 状态 | 读 bootstrap 记忆 | 使用记忆工具 | 面板手动整理 | 面板定时整理 |
|---|---:|---:|---:|---:|
| `scratch` | 是 | 是 | 否 | 否 |
| `eligible` | 是 | 是 | 是 | 后续可选 |

规则如下：

- 新建会话默认 `scratch`；fork / 编辑重发产生的新会话也默认 `scratch`，不继承来源会话的 `eligible`。
- UI 使用「不整理进记忆」与「允许整理进记忆」，不把内部枚举直接暴露给普通用户。
- 从 `eligible` 改回 `scratch` 只阻止后续整理，不删除已经确认写入的记忆。
- 隐藏、归档或删除来源会话，不自动删除已经确认写入的记忆；两者是独立的权威数据。
- active / reset 只读会话的处置状态仍只写面板 sidecar，不修改 OpenClaw 源 transcript。手动整理只读取其稳定快照。

### 「不会写记忆」的强度边界

首版能可靠保证：`scratch` 不会进入面板的候选提炼、确认写入或未来的定时整理队列；面板自己的记忆写 API 必须拒绝 `scratch` 来源。

首版**不能**在保留完整 shell / 文件工具能力的同时，硬性阻止模型按用户明确指令直接修改 workspace 中的 `MEMORY.md` 或 `memory/`。OpenClaw 当前没有普通 session 的按路径只读策略；禁用所有写文件和 shell 工具又会破坏编码 agent 的主要能力。是否把「模型工具也绝对不能写」升级为硬安全要求，仍需产品决定，见文末。

## 首版记忆中心

记忆中心先做只读浏览：

- 仅从服务端配置的 agent workspace allowlist 读取 `MEMORY.md`、`DREAMS.md` 与 `memory/**/*.md`；浏览器不能提交主机路径。
- 列表显示文件类别、相对路径、修改时间和大小；内容按 Markdown 安全渲染，并设单文件/单响应大小上限。
- 拒绝符号链接、特殊文件、路径穿越和 allowlist 外路径；接口沿用登录、同源、CSRF 与 `no-store` 边界。
- 面板生成的记忆通过面板 ledger 展示来源会话与整理时间，并可跳回仍存在且可见的来源会话；普通 OpenClaw 文件不伪造来源。
- 首版不在线编辑任意记忆文件，不提供任意 workspace 文件浏览器，也不把记忆正文写入服务日志。

## 手动整理流程

首版采用可恢复的两阶段流程：

1. 用户把会话标为 `eligible`，点击「整理到记忆」。
2. 服务端读取当前权威分支及该会话的上次成功 checkpoint，只选取尚未整理的消息；不信任浏览器提交 transcript 或 entry 范围。
3. 通过目标 agent 的推理能力生成候选 Markdown。提示词要求提炼事实、偏好、决定和仍有后续价值的上下文，排除工具噪音、重复内容、凭据和未经确认的推断。
4. 候选只暂存在面板数据目录，展示给用户预览；此时不改 workspace，也不推进 checkpoint。
5. 用户确认后，服务端在可信 workspace 下以唯一文件名创建 `memory/YYYY-MM-DD-ark-panel-<batch>.md`。文件名符合 OpenClaw 已支持的带 slug 每日记忆格式，与 OpenClaw 自己的日期文件不共写。
6. 文件落盘并完成 durability 边界后，原子记录 ledger 与「已整理到哪个 entry」的 checkpoint。任一步失败都不能出现 checkpoint 超前。
7. OpenClaw 文件 watcher 负责后续索引；是否最终 promote 到 `MEMORY.md` 仍由 OpenClaw 决定，面板不复刻 promote 算法。

候选文件只保存确认后的记忆内容。来源 record、entry 范围、内容 hash、目标相对路径、创建时间和状态保存在面板自己的 ledger 中，避免把内部追踪元数据混进模型可召回正文。

### 并发、幂等与纠错

- 同一会话的提炼和确认使用 keyed mutex；确认请求带 batch id 和候选 hash，重复确认只能得到同一结果。
- 目标文件使用唯一 batch id 且禁止覆盖现有文件；不与 OpenClaw 追加写同一个日期文件。
- checkpoint 以权威分支 entry id 表示，不能只用消息数；fork 后是新的会话和新的 checkpoint。
- 用户在确认前继续聊天时，当前候选仍只覆盖生成候选时的固定范围；后续消息留给下一批，不能偷偷扩大确认内容。
- 删除尚未 promote 的面板短期文件可以阻止它继续作为源记忆，但不能自动撤销已经进入 `MEMORY.md` 的独立副本。因此 UI 不得把删除短期文件描述成「完整撤回长期记忆」。

## 后续自动整理

自动整理复用同一套增量提炼、候选和 ledger，不另建一条隐式写路径。首版验证稳定之后才考虑：

- 仅扫描 `eligible` 且 checkpoint 后有新消息的会话；
- 设置中提供服务器端、跨终端的总开关和时间表；
- 默认仍要求确认，是否允许「自动确认并写入」另行决策；
- 与 `/compact` 共用 checkpoint 概念，但压缩本身不能暗中把 `scratch` 改成 `eligible`；
- 自动任务失败只记录脱敏状态并保留待整理范围，不影响聊天生成。

## 明确不做

- 不为面板新建一套与 OpenClaw 竞争的长期向量记忆数据库。
- 不把原始 transcript 当记忆文件写入 workspace。
- 不直接追加或重写 `MEMORY.md` / `DREAMS.md`。
- 不让浏览器选择、读取或写入任意服务器路径。
- 不把「删除面板短期文件」伪装成已经从长期记忆完全撤销。

## 尚需 Owl 决策

1. **scratch 的硬边界**：接受「禁止面板自动沉淀，但用户明确要求模型用工具写记忆时仍可能发生」（推荐，保留完整 agent 能力），还是要求工具层绝对不可写记忆路径（需要隔离/COW workspace 或 OpenClaw 新能力，属于明显更大的工程）。
2. **从 scratch 改成 eligible 时的起点**：整理当前分支全部尚未 checkpoint 的历史（推荐，符合用户聊完后才发现值得保留的习惯），还是只整理切换之后的新消息。
3. **提炼模型**：首版沿用该会话的有效模型/思考设置（推荐，行为直观），还是单独配置一个更便宜的服务器端记忆整理模型。
4. **确认粒度**：首版确认整份候选 Markdown（推荐，改动小），还是从第一版就拆成逐条勾选/编辑的候选卡片。

自动整理的执行时间与是否允许自动确认留到手动流程真实使用后再决定，不阻塞首版。

## 相关

- 需求与架构：[`../architecture.md`](../architecture.md)
- 字段、接口与验收：[`../implementation-spec.md`](../implementation-spec.md)
- OpenClaw 版本升级约束：[`engineering-decisions.md`](engineering-decisions.md)
