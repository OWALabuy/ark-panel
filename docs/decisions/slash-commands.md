# 斜杠命令首版决定

日期：2026-07-12

## 结论

当前实现已适配 A 类面板原生命令（`/model`、`/think`、`/reasoning`、`/new`）与 C 类只读命令（`/commands`、`/help`、`/status`、`/models`、`/tools`、`/usage`）。普通消息接口永久拒绝把以 `/` 开头的输入当作模型消息发送；命令只从独立结构化派发接口进入。

这不是只处理两个命令。OpenClaw `2026.6.11` 当前运行时注册了 48 个核心命令、59 个文本别名；此外还有随渠道、插件和 skill 动态变化的命令。动态目录用于展示和补全，不能被直接视为可执行清单；面板实际执行范围必须是一份经过评审、版本化、default-deny 的静态 allowlist。

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

斜杠命令原本是为 **gateway 管理的会话**设计的。而在 2a′ 架构里，面板自建会话的状态由**面板自己拥有**，在 gateway 那边没有持久 session，只有每轮一个的临时 session。所以「支持斜杠命令」的很大一部分，其实是**用用户熟悉的命令名与交互，提供面板原生的等价能力**，而不是真的去 gateway 跑一条 OpenClaw 命令。gateway 的能力只在一处真正被借用——`/compact` 借 gateway 的**压缩引擎**（经 `sessions.compact` typed RPC，仍非命令引擎）。没有任何命令走 gateway 的命令引擎（那要求把 `/xxx` 送进 send 路径，恰是原则 1 禁止的）。

### 命令四分类（按「谁拥有这个效果」）

| 类 | 命令（举例） | 面板怎么做 | 首版 |
|---|---|---|---|
| **A 面板原生** | `/model` `/think` `/reasoning` `/new` | 存进**面板会话 metadata**，每轮推理经 `sessions.create` 参数或 `sessions.patch` 应用到临时 session。`/new` = 新建面板会话（已有）。这顺带实现 §8.6「会话中途换模型」——同一件事。 | ✅ 做 |
| **B `/compact`（特殊）** | `/compact` | 面板会话无持久 gateway session 可压。做法：物化历史 → 临时 session 上调 **`sessions.compact` typed RPC**（**绝不把 `/compact` 送进 `sessions.send`**，否则违反原则 1/2）→ **读回压缩后的 transcript → 采纳进面板存储** → 删临时 session。把 gateway 压缩引擎当计算引擎用。**这就是长上下文策略本身**，与之合流。 | 归长上下文 |
| **C 信息类**（只读代理，低风险） | `/help` `/commands` `/status` `/models` `/tools` `/usage` | 调已核实的只读 RPC/CLI，或由面板基于 allowlist / 权威 transcript 生成。数据来源未核实的命令不进入 allowlist。 | ✅ 已实现 |
| **D gateway 管理 / owner 全局** | `/config` `/restart` `/mcp` `/plugins` `/reset` | 属于 gateway 管理面。面板是会话 UI，不是 gateway 控制台；`/reset` 对面板会话无对应语义。 | 默认不做 |

- 对**真实活会话**执行任何命令，等同于向活会话写入其与 IM 共享的上下文桶，属于「向活会话发消息」的安全边界（architecture §6.7），随该边界一起推迟，不在本设计范围。

### `/bash` 的处理：未来可能的面板原生能力，当前不实现

**先纠正一处定位错误。** 早先把 `/bash` 归到「D 类经独立派发路径」是矛盾的：gateway **没有 `commands.execute` 这类命令执行 RPC**（见前文「关键机制发现」），命令的唯一执行方式是把 `/xxx` 送进 send 路径——而那恰是原则 1 禁止的。所以 `/bash` 不可能「映射到一个 typed RPC」；把 `/bash` 送进 gateway 又违反原则 1。**唯一自洽的实现是：面板自己执行 shell。**

因此 `/bash` **重新定义为一项面板原生能力**（与「面板拥有会话文件」同性质），不是对某条 gateway 命令的代理。`/bash` 只是这项能力沿用的、用户熟悉的**触发名**（type-to-invoke 入口），执行体在面板服务内。

- 面板是单用户、登录 + SSH 隧道后的自用工具，进程执行能力可能有用，但当前只记录立项方向。
- 当前没有启用开关，也不进入 allowlist；任何 `/bash` 派发都拒绝。未来只有在 §5.6 的执行模型和数值约束全部拍板后，才增加部署开关。
- 明确接受的权衡：一旦开启，「面板登录失守」在后果上等同于「shell 访问」。因此开启 bash 时，登录强度（慢哈希口令、限速、SameSite=Strict cookie、仅 localhost 监听 + SSH 隧道）是前提，不是可选项。
- 若未来实现，仍不得违反原则 1/2：`/bash` 不经普通消息路径，也不把任何命令字符串送进推理桥接的 `sessions.send`；它走独立派发接口，落到届时经过安全评审的面板进程执行器。
- **需要独立安全设计（本文件不展开，见 implementation-spec §5.6）**：进程执行还是 shell 文本、cwd、环境变量、超时、输出上限、进程终止、并发上限、审计日志，以及「开启要求登录已启用」的启动期校验。在这份安全设计落定前，`/bash` 不进入实现批次。

### 交互形态：打命令（type-to-invoke），不是点菜单

- Owl 已定：输入框敲 `/` 触发命令，而非纯下拉列表。理由是 **skill 命令是动态注册的**（`skill:<name>`），数量与名称随装配变化，列表点选不实用；打字补全更顺手。
- 客户端在输入框敲 `/` 时做**命令补全**（来源 `commands.list` + 面板原生命令）。allowlist 内命令可选择执行；其余命令灰显并标注「仅 OpenClaw 原生渠道可用」，客户端不派发。
- 选中命令后，**走独立的命令派发 API**（例如 `POST /api/v1/sessions/<id>/command`），**不是**普通消息发送接口。这条独立路径在服务端按四分类校验并映射到原生操作或 typed RPC。
- **不变量**：普通消息发送接口永远拒绝 `/`；命令永远从独立派发路径进入。两条路径的隔离，是「admin 连接不成为脚枪」的结构性保证——只要隔离守住，就无需为安全而降权连接（降权记为后续可选加固，非必需）。

### 仍需遵守（沿用并细化原「原则」）

1. 展示目录来自 gateway `commands.list`（含 skill/plugin 动态命令）；实际可执行范围使用面板显式、版本化、default-deny 的服务端 allowlist。owner/surface/run 三类可用性 gateway **不在 list 里返回**，未评审命令默认不可执行。
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
