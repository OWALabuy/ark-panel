# 面板记忆系统首版决定

日期：2026-07-12

## 结论

首版面板记忆系统以**控制层（路线 C）打底**：给每条面板会话一个记忆倾向标记（`eligible` / `scratch`），`scratch` 会话推理时收窄记忆副作用，避免调试 / 草稿对话污染真实 agent 的长期记忆。**按需再叠路线 B**：把该沉淀的内容以 OpenClaw 认得的形式喂给原生 promote，不在面板复刻记忆归档逻辑。首版不新建独立记忆层，也不直接编辑 `MEMORY.md`。

## 为什么需要这个功能：一个缺口 + 一个风险

功能起点是「不确定 OpenClaw 是否原生支持定时整理最近活跃会话进记忆，面板会话算不算在内」。通过读 OpenClaw `2026.6.11` 打包源码（`~/.nvm/.../node_modules/openclaw/dist/`）确认了机制，结论如下。

### OpenClaw 原生记忆机制（源码实证）

- **只认一个维度：`workspaceDir`。** recall store 的 key = `sha256(resolve(workspaceDir))`（`dreaming-state-DWd_V39L.js:22-34`），**不含 agentId，也不含 session id**。共用同一 workspace 的所有 agent / session 共享同一份 recall store 和同一个 `MEMORY.md`。
- **cron 归档读的是 recall store，不是直接读 transcript。** promote 候选来自 `rankShortTermPromotionCandidates` → `readStore(workspaceDir)`（`short-term-promotion-B-Lvx_wV.js:1507`），入选后追加进 `workspaceDir/MEMORY.md`。
- **recall store 两条写入路径**：(A) 推理时 `memory_search` 命中被记下（`tools-CKG9WyW0.js:390`）——记的是「旧记忆被召回」信号，不是新内容；(B) cron sweep 主动扫**已注册 agent 的 sessions 目录** transcript 抽信号（`dreaming-phases-5lPsmHJc.js:458`）。
- **recall store 不依赖 session 文件存活**（按 workspace 键控的持久化存储），但 promote 落盘时需要候选指向的短期记忆文件（workspace 内的 `memory/*.md`）仍在。
- **压缩前 memory flush 是 per-session**，要活跃 session 累积到接近压缩阈值才触发（`agent-runner.runtime-BriI2__w.js:835`），且 heartbeat / CLI 不触发 → **面板一次性 session 永远触发不了**。
- **promote 阈值**：min score 0.75、min recall 3、min unique queries 2（`short-term-promotion:532-534`）。单次会话很难越过，但信号会持续累积。

### 由此得出的缺口与风险

**缺口——面板会话新内容基本进不了记忆：**
- 面板会话权威 transcript 存在 `PANEL_DATA_DIR`，OpenClaw 完全不知道这个目录，sweep 永远扫不到。
- 面板推理用一次性临时 session，跑完即删；即便临时 session 挂在被 sweep 的 runtime agent 下，也要正好撞上「session 尚未删除」的时间窗才可能被扫到。
- 路径 A 的 `memory_search` 记的是旧记忆召回信号，不代表今天聊出的新内容。
- 压缩前 flush 触发不了。
→ 所以「面板里聊出来的东西沉淀进记忆」确实是原生机制盖不到的缺口。

**风险——共用 workspace 让调试噪音有渗入真实记忆的通路：**
- `panel-runtime-<agent>` 与真实 agent 共用 workspace（§二部署、engineering-decisions「OpenClaw 兼容与推理 runtime」），而记忆只认 workspace key。
- 面板推理（2a′ 强制保留 `memory_search`，见 architecture §5.4）的召回信号写进的是**与真实 agent 共用的 recall store**。
- 若 `panel-runtime-<agent>` 被登记进 dreaming 扫描列表，sweep 撞上临时 session 未删的时间窗，面板对话还会被反思进共用 store，进而可能 promote 进真实 `MEMORY.md`。
- 当前满是调试 / 修 bug 的对话，不应污染真实 agent 攒了几年的长期记忆。阈值不低，目前大概率尚未实际污染多少，但架构上这条路是开着的。

## 首版做法：路线 C（控制层）

给每条面板会话一个 `memoryDisposition`：

- `eligible`：可进记忆，推理保持默认 2a′（完整工具、`memory_search` 在场、共用 workspace），记忆注入与归档行为不退化。
- `scratch`：草稿 / 调试，**不得渗入真实记忆**。收窄方式二选一（实现时在 `paneltest` 实测择定，记进代码注释）：
  1. 该轮不装配 `memory_search` / `memory_get`（仅对 `scratch` 生效，不违反 `eligible` 会话的 2a′ 约束）；
  2. 或让 `scratch` 会话在**独立一次性 workspace** 下推理，从 workspace key 层面切断渗入。
- **权衡**：方式 2 更彻底（记忆只认 workspace key，换 workspace 即换 store），但失去共用 workspace 的记忆注入；方式 1 保留注入但依赖「少调 memory_search」这一较弱保证。

### `memoryDisposition` 默认值：`scratch`（Owl 已定 2026-07-12）

新建 / fork 面板会话默认 `scratch`（不碰记忆），想沉淀的会话由用户手动标 `eligible`。
- 取此默认的理由：避免调试 / 草稿对话不受控地污染真实 agent 的长期记忆；「想留」是明确意图，交给用户显式开启，比「想丢」要主动标记更安全。
- 代价（接受）：有价值的会话需要用户主动开一下 `eligible` 才会进记忆归档。

## 按需叠加：路线 B（喂原生 promote，首版可不做）

把 `eligible` 会话中该沉淀的内容，以 OpenClaw 认得的形式写入共用 workspace 的短期记忆文件（如 `memory/YYYY-MM-DD.md`），让原生 cron sweep + promote 接手。**面板只写「喂料」文件，promote 仍由 OpenClaw 执行，面板不复刻归档逻辑。**

未定（路线 B 正式立项时再定）：
- 触发时机（是否每天定时、类似用户设想的「3 点整理」）。
- 扫哪些 `eligible` 会话、如何界定「最近活跃」。
- 如何避免与 gateway cron 并发写同一记忆文件。
- 与长上下文压缩策略的关系：压缩点执行一次侧重 `memory_search` 的推理来补记忆归档，正是路线 B 的自然落点（见 implementation-spec 首版之后路线第 22 项）。

## 硬约束

- 面板**绝不直接编辑 `MEMORY.md` / `DREAMS.md`**：它们是 OpenClaw promote 的产物，并发写会与 cron 冲突。路线 B 只写喂料的短期记忆文件。
- 记忆机制的所有假设（workspace key、阈值、flush 条件）建立在 OpenClaw `2026.6.11` 上，升级后须重验（见 engineering-decisions「版本控制与升级维护」第 6 项）。

## 相关

- 需求：`architecture.md` §一-15、§6.8（会话管理承载记忆倾向标记）。
- 实现与验收：`implementation-spec.md` §4.3（`memoryDisposition` 字段）、§5.5（收窄方式与验收）、首版之后路线第 19–20、22 项。
- 记忆机制源码结论详版见项目记忆 `openclaw-memory-is-workspace-keyed`。
