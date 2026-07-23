# 面板记忆模块决定

日期：2026-07-12
修订：2026-07-23

## 结论

面板把「使用既有记忆」与「让当前会话贡献新记忆」分成两个独立概念：

1. **所有面板会话都读取既有记忆。** `scratch` 与 `eligible` 均使用目标 agent 的真实 workspace、bootstrap 记忆和 `memory_search` / `memory_get`，不得因为会话不沉淀而让 agent 失去连续性。
2. **`memoryDisposition` 只控制当前会话能否进入面板管理的记忆沉淀流程。** `scratch` 不会被面板提炼、写入或定时整理；只有 `eligible` 才能产生候选记忆。
3. **每条会话维护一份可审阅、滚动修订的短期记忆。** 首次整理使用该会话的完整当前分支；后续整理使用「上一版已确认记忆 + checkpoint 后新增原文」生成更新后的整份文档。用户确认后，面板原子创建或替换该会话唯一的 `memory/ark-panel/<record-key>.md`；不直接编辑 `MEMORY.md` 或 `DREAMS.md`。
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

普通 scratch 对话仍保留完整 agent 能力。用户明确要求模型通过 shell / 文件工具写记忆时允许发生；`memoryDisposition` 不拦截这种显式工具操作。这里的“不整理”只约束面板自己的候选、确认和自动任务，不能被描述成 workspace 的通用只读安全边界。

这不适用于面板发起的候选提炼内部 session：预览确认语义要求确认前 workspace 不变，所以该内部 session 必须采用经 `paneltest` 验证的只读/无副作用工具策略，并拒绝产生任何写工具轨迹。OpenClaw 普通 session 不能动态 deny 工具；实现可使用通过版本验收的受限 subagent session capability，若该路径不可用则需专用受限 runtime，不能退化成“只在提示词里说不要写”。

## 首版记忆中心

记忆中心先做只读浏览：

- 记忆中心是与设置抽屉分离的独立工作区；入口固定在最左侧 Agent 栏的设置齿轮正上方，收起 rail 保持同样顺序。进入后保留 Agent 栏，切换 Agent 只刷新对应记忆树，不退出记忆工作区。
- 桌面端左侧按长期、梦境、每日/主题和会话记忆分组为树状导航，右侧安全渲染文件；移动端使用「文件树 → 文件正文」两级视图。返回会话恢复进入前的页面与焦点。
- 仅从服务端配置的 agent workspace allowlist 读取 `MEMORY.md`、`DREAMS.md` 与 `memory/**/*.md`；浏览器不能提交主机路径。
- 列表显示文件类别、相对路径、修改时间和大小；内容按 Markdown 安全渲染，并设单文件/单响应大小上限。
- 拒绝符号链接、特殊文件、路径穿越和 allowlist 外路径；接口沿用登录、同源、CSRF 与 `no-store` 边界。
- 面板生成的记忆通过面板 ledger 展示来源会话标题与整理时间，并可跳回仍存在且可见的来源会话；滚动文件的 hash 路径只作为次要元数据，不能取代友好标题。普通 OpenClaw 文件不伪造来源。
- 首版不在线编辑任意记忆文件，不提供任意 workspace 文件浏览器，也不把记忆正文写入服务日志。

## 手动整理流程

首版采用可恢复的两阶段流程：

1. 用户把会话标为 `eligible`，点击「整理到记忆」。
2. 服务端读取当前权威分支及该会话的上次成功 checkpoint，只选取尚未整理的消息；首次从 `scratch` 改为 `eligible` 时，从当前分支起点开始整理全部历史。不信任浏览器提交 transcript 或 entry 范围。
3. 在**独立的一次性内部 session** 中生成候选 Markdown，沿用来源会话的有效模型、thinking 和 reasoning 设置。首次整理把固定范围历史作为输入；后续整理把该会话上一版已确认记忆明确放入输入，再附上固定范围内的新增原文，要求模型输出更新后的完整会话记忆，而不是仅输出追加片段。该 session 使用经版本验收的无写入工具策略；不得向模型开放 shell、文件写入或其它有副作用的工具。可以保留只读的 `memory_search` / `memory_get`，但正确性不能依赖 OpenClaw 隐式注入旧记忆。
4. 内部 session 的 user/assistant/tool/reasoning entries 都不追加进原会话；面板只取最终候选 Markdown，暂存在面板数据目录并整份展示给用户预览。此时不改 workspace，也不推进 checkpoint。
5. 用户确认后，服务端在可信 workspace 下原子创建或替换 `memory/ark-panel/<record-key>.md`。`record-key` 由服务端对稳定 recordId 做单向摘要得到；浏览器不能指定路径。该文件只归属于一条面板会话，不与 OpenClaw 自己的日期文件或其他会话共写。
6. 文件落盘并完成 durability 边界后，原子记录 ledger 与「已整理到哪个 entry」的 checkpoint。任一步失败都不能出现 checkpoint 超前。
7. OpenClaw 文件 watcher 负责后续索引；是否最终 promote 到 `MEMORY.md` 仍由 OpenClaw 决定，面板不复刻 promote 算法。

候选文件保存本次确认后应成为当前版本的**完整会话记忆**。来源 record、entry 范围、基线版本 hash、候选内容 hash、目标相对路径、创建/确认时间和状态保存在面板自己的 ledger 中，避免把内部追踪元数据混进模型可召回正文。

整理不是原会话中的一次隐藏聊天回复。它有独立的 job/run 身份、临时 session 和清理生命周期；成功、失败或重试都不能改变原会话 transcript revision。确认写入由面板存储层完成，不让模型通过一串 shell / 文件工具调用自行写记忆，因此不会把“写记忆”的工具轨迹污染聊天上下文。

### 并发、幂等与纠错

- 同一会话的提炼和确认使用 keyed mutex；确认请求带 batch id 和候选 hash，重复确认只能得到同一结果。
- 目标路径按 recordId 稳定派生；同一会话只维护一个当前文件，不与 OpenClaw 或其他会话共写。替换前必须复核 checkpoint 与上一版内容 hash，使用临时文件、`fsync` 和原子 rename，禁止多行 append 或原地截断写。
- checkpoint 以权威分支 entry id 表示，不能只用消息数；fork 后是新的会话和新的 checkpoint。
- 用户在确认前继续聊天时，当前候选仍只覆盖生成候选时的固定范围；后续消息留给下一批，不能偷偷扩大确认内容。
- 同一 checkpoint 产生多个候选时，只允许首个成功确认；旧候选不能覆盖已经推进的会话记忆。
- 删除尚未 promote 的面板短期文件可以阻止它继续作为源记忆，但不能自动撤销已经进入 `MEMORY.md` 的独立副本。因此 UI 不得把删除短期文件描述成「完整撤回长期记忆」。

### 旧 batch 文件迁移与回滚

- 旧版 ledger 中每次确认对应一个 `memory/YYYY-MM-DD-ark-panel-<batch>.md`。升级后第一次再次整理时，服务端按 ledger 顺序安全读取仍存在且 hash 匹配的旧文件，把它们作为上一版已确认记忆基线；缺失、越界、链接或 hash 不匹配时拒绝整理，不静默丢弃。
- 新滚动文件与新版 state 完成 durability 后，旧 batch 文件才可清理。清理必须逐个复核它仍是 ledger 登记的普通单链接文件且内容 hash 未变；失败可留下重复索引文件，但不能删除不确定的用户文件，也不能回滚已经确认的新 checkpoint。
- 升级前尚未确认的旧版候选没有改变 workspace 或 checkpoint，可以丢弃并重新生成；服务端不得把旧版增量候选误当作新版整份替换候选确认。
- 回滚到旧版本前，应保留旧 batch 文件；若它们已经被安全清理，则从面板候选/ledger 中导出最新确认正文为旧版支持的新 batch 文件。面板不得把新版 state 静默解释成旧版 state。

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
- 不把每次增量候选机械追加到会话记忆；旧状态、重复事实和已完成待办必须允许在整份修订中被更新或删除。
- 不让浏览器选择、读取或写入任意服务器路径。
- 不把「删除面板短期文件」伪装成已经从长期记忆完全撤销。

## Owl 已定（2026-07-22）

1. scratch 只禁止面板管理的沉淀流程；普通对话中，用户明确要求模型用 shell / 文件工具写记忆时允许执行，不做工具层绝对隔离。
2. 从 scratch 改成 eligible 后，首次整理覆盖当前分支全部尚未 checkpoint 的历史，不只看切换后的消息。
3. 首版提炼沿用来源会话的有效模型与思考设置，但运行在独立内部 session；任何提炼、推理和工具轨迹都不进入原会话上下文。
4. 首版整份预览、整份确认候选 Markdown，不做逐条勾选或逐条编辑。

自动整理的执行时间与是否允许自动确认留到手动流程真实使用后再决定，不阻塞首版。

## 相关

- 需求与架构：[`../architecture.md`](../architecture.md)
- 字段、接口与验收：[`../implementation-spec.md`](../implementation-spec.md)
- OpenClaw 版本升级约束：[`engineering-decisions.md`](engineering-decisions.md)
