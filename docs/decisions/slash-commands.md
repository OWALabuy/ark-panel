# 斜杠命令首版决定

日期：2026-07-12

## 结论

首版会话面板不实现 OpenClaw 斜杠命令。面板移除 `/reset`、`/compact` 快捷入口，并拒绝把以 `/` 开头的输入当作普通模型消息发送。

这不是只推迟两个命令。OpenClaw `2026.6.11` 当前运行时注册了 48 个核心命令、59 个文本别名；此外还有随渠道、插件和 skill 动态变化的命令。命令可用性还受配置、surface、owner 身份和当前 run 状态影响，不能在面板里硬编码一份静态子集。

## 当前面板为什么不能透明支持命令

面板的推理桥接为每一轮创建一次性 runtime session，物化历史、执行一次 `sessions.send`，搬回新增 transcript 后注销并清理 runtime session。普通对话已经实测可用，但完整命令语义依赖 gateway 的会话和命令分派状态：

- `/model`、`/think`、`/queue` 等设置需要跨轮持久化；
- `/compact`、`/reset`、`/new` 会改变 gateway session 或 transcript 生命周期；
- `/stop`、`/steer` 需要定位正在运行的 run；
- `/config`、`/plugins`、`/restart`、`/bash` 等涉及 owner 权限或全局状态；
- 插件、skill 和 dock 命令是动态注册的。

若仅把命令字符串送进当前普通消息接口，部分命令的状态会随临时 session 被删除，部分命令会破坏增量 transcript 假设，也无法保证权限和返回结果正确。因此首版不提供不完整或看似可用的命令入口。

---

## 后续适配设计（2026-07-12 源码核实后确定）

> 下文取代了原先笼统的「后续适配原则」。基于对 OpenClaw `2026.6.11` 打包源码的核实，命令分派机制已经查清，适配方向随之收敛为一套具体分类。源码结论详见本节末「源码依据」。

### 关键机制发现：命令是「带内」执行的，没有执行 RPC

- gateway **没有** `commands.execute` / `command.dispatch` 之类的命令执行 RPC。命令的唯一执行方式，是把 `/xxx` 当作**普通消息文本**提交给 `chat.send` / `sessions.send`，send 处理路径在内部识别 `/` 前缀并走命令分派（`handleCommands`）。
- `sessions.send` 直接委托给 `chat.send`。因此**面板推理桥接的那条 `sessions.send`，只要提交文本以 `/` 开头，命令就会被真的执行**，且被 gateway 标为 `authorized: true`。
- 但它作用的对象是那个**一次性临时 session**：`/compact` 压缩的是即将被删的副本，`/model` 改的是临时 entry 的 override。`sessions.delete` 一删，这些状态全部消失，对面板持久 transcript 零影响。
- **安全事实（划重点）**：面板当前以 `operator.admin` scope 连接 gateway（清理用的 `sessions.delete` 需要 admin）。owner 判定 `senderIsOwnerByScope` 只要求「内部 channel + 连接持有 `operator.admin`」即成立。这意味着：**任何 `/` 文本一旦漏进推理桥接，`/bash`、`/restart` 这类命令会被 gateway 自动授权执行。** v1 在服务端拒绝一切 `/` 开头输入，不是保守，是必需的隔离防线。

### 由此确立的两条设计原则

1. **永不把命令当 `/` 文本带内塞进推理桥接。** 普通消息发送路径继续拒绝 `/` 开头输入（沿用 v1 的 `SLASH_COMMANDS_UNSUPPORTED`），命令永不从推理桥接意外执行。
2. **每个命令映射到「面板原生操作」或「专用 typed RPC」，绝不透传命令字符串。** 需要的 typed RPC 都存在：`sessions.compact`、`sessions.patch`（写 `modelOverride`）、`sessions.abort` / `sessions.steer`、`commands.list`、`status`。

### 定位重述：命令大多是面板原生操作，不是「转发给 gateway」

斜杠命令原本是为 **gateway 管理的会话**设计的。而在 2a′ 架构里，面板自建会话的状态由**面板自己拥有**，在 gateway 那边没有持久 session，只有每轮一个的临时 session。所以「支持斜杠命令」的很大一部分，其实是**用用户熟悉的命令名与交互，提供面板原生的等价能力**，而不是真的去 gateway 跑一条 OpenClaw 命令。gateway 的命令引擎只在一处真正被当作引擎用——`/compact`。

### 命令四分类（按「谁拥有这个效果」）

| 类 | 命令（举例） | 面板怎么做 | 首版 |
|---|---|---|---|
| **A 面板原生** | `/model` `/think` `/reasoning` `/new` | 存进**面板会话 metadata**，每轮推理经 `sessions.create` 参数或 `sessions.patch` 应用到临时 session。`/new` = 新建面板会话（已有）。这顺带实现 §8.6「会话中途换模型」——同一件事。 | ✅ 做 |
| **B `/compact`（特殊）** | `/compact` | 面板会话无持久 gateway session 可压。做法：物化历史 → 临时 session 跑 `/compact` → **读回压缩后的 transcript → 采纳进面板存储** → 删临时 session。把 gateway 压缩引擎当计算引擎用。**这就是长上下文策略本身**，与之合流。 | 归长上下文 |
| **C 信息类**（只读代理，低风险） | `/help` `/commands` `/status` `/models` `/tools` `/usage` | 调 `commands.list` / `status` 等只读 RPC，面板渲染结果。 | ✅ 做 |
| **D gateway 管理 / owner 全局** | `/config` `/restart` `/mcp` `/plugins` `/reset` `/bash` | 属于 gateway 管理面。面板是会话 UI，不是 gateway 控制台。`/reset` 对面板会话无对应语义。**`/bash` 例外见下**。 | 默认不做 |

- 对**真实活会话**执行任何命令，等同于向活会话写入其与 IM 共享的上下文桶，属于「向活会话发消息」的安全边界（architecture §6.7），随该边界一起推迟，不在本设计范围。

### `/bash` 的处理：部署时可选（默认关）

`/bash` 归 D 类，但作为**部署可选功能**开放：面板是单用户、登录 + SSH 隧道后的自用工具，用户信任自己的机器，直接执行 shell 有真实用处。

- 默认**关闭**；由部署配置显式开启（如 `PANEL_ENABLE_BASH=1`）。
- 明确接受的权衡：一旦开启，「面板登录失守」在后果上等同于「shell 访问」。因此开启 bash 时，登录强度（慢哈希口令、限速、SameSite=Strict cookie、仅 localhost 监听 + SSH 隧道）是前提，不是可选项。
- 这不改变原则 1：`/bash` 仍走独立命令派发路径，绝不经由拒绝 `/` 的普通消息发送路径。

### 交互形态：打命令（type-to-invoke），不是点菜单

- Owl 已定：输入框敲 `/` 触发命令，而非纯下拉列表。理由是 **skill 命令是动态注册的**（`skill:<name>`），数量与名称随装配变化，列表点选不实用；打字补全更顺手。
- 客户端在输入框敲 `/` 时做**命令补全**（来源 `commands.list` + 面板原生命令），供用户挑选。
- 选中命令后，**走独立的命令派发 API**（例如 `POST /api/v1/sessions/<id>/command`），**不是**普通消息发送接口。这条独立路径在服务端按四分类校验并映射到原生操作或 typed RPC。
- **不变量**：普通消息发送接口永远拒绝 `/`；命令永远从独立派发路径进入。两条路径的隔离，是「admin 连接不成为脚枪」的结构性保证——只要隔离守住，就无需为安全而降权连接（降权记为后续可选加固，非必需）。

### 仍需遵守（沿用并细化原「原则」）

1. 命令目录来自 gateway `commands.list`（含 skill/plugin 动态命令），面板不硬编码命令清单；owner/surface/run 三类可用性 gateway **不在 list 里返回**，由面板按分类判断或在派发时由 gateway 执行层裁决。
2. 命令效果由 typed RPC 或面板原生操作实现，面板不复刻命令业务逻辑（`/compact` 用 gateway 压缩引擎，不自研压缩算法）。
3. 保留 gateway 的配置开关、owner 权限和 surface 限制：面板不绕过它们，D 类命令即便有 admin scope 也默认不暴露入口。
4. A 类会话设置持久化在**面板会话 metadata**，而不是依赖临时 session 或长期 runtime session。
5. `/stop` 用 `sessions.abort` 对当前活动 run 的 sessionKey 调用（面板已有停止生成能力，可直接复用）。
6. OpenClaw 升级后重新拉取 `commands.list` 并复核分派机制（见 engineering-decisions「版本控制与升级维护」软耦合面第 3 项）。

### 源码依据（OpenClaw 2026.6.11）

- 命令检测：`command-detection-RzPDnyTh.js`（`hasControlCommand`）。
- send 路径内构造命令 ctx：`chat-DFeIryVW.js:2540-2592`（`/` 前缀 → `text-slash` / `authorized:true`）。
- 执行入口：`commands.runtime-CeUhEv7W.js:165`（`handleCommands`）；get-reply 调用点 `get-reply-D-_K5pna.js:2197`。
- `sessions.send` 委托 `chat.send`：`sessions-DC378bJ-.js:349, 420, 929`。
- 唯一命令 RPC `commands.list`（`operator.read`）：`core-descriptors-B2lASufG.js:284`；结果构造 `commands-list-result-6RigR70i.js`。
- 生命周期/设置 RPC：`sessions.compact`(576) / `sessions.reset`(568) / `sessions.abort`(551) / `sessions.steer`(821) / `sessions.patch`（写 `modelOverride`，见 `get-reply-D-_K5pna.js:1587,4648`）。
- owner 判定 `senderIsOwnerByScope`（内部 channel + `operator.admin`）：`command-auth-BBZwnH2N.js:368-414`。
- 命令目录 = 编译期基座 + 运行期 skill/plugin 增量：`commands-registry.data-OJjTQeIV.js`、`commands-registry-list-Pb9MPbeS.js`。

## 首版用户可见行为

- 输入普通消息：按既有隔离 runtime 桥接执行。
- 输入以 `/` 开头的内容：普通消息发送路径返回 `SLASH_COMMANDS_UNSUPPORTED`，不调用 gateway、不写入 panel transcript。斜杠命令能力随上表 A / C 类逐步通过**独立命令派发路径**提供，不改变普通消息路径拒绝 `/` 的行为。
- 需要 D 类 gateway 管理命令（`/config`、`/restart` 等）：继续在原有 Telegram、飞书、TUI 或其他 OpenClaw surface 中执行。
