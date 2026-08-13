# ark-panel

[English](README.md) · [简体中文](README.zh-CN.md)

> 一个自托管的 OpenClaw 网页面板。把每一段对话都留在自己的船上。

洪水来临时，方舟的意义不在于逃离，而在于你拒绝舍弃的东西。
ark-panel 把每一段对话都保存在你自己的机器上:随时浏览、回到任意一段、从任意时刻派生分支，并带着它们去任何地方。

账号会过期，服务器会关停，多年的对话可能只剩下一份再也没人能读懂的 JSON 导出文件。
ark-panel 是一个自托管的 OpenClaw 会话面板——一个类似 claude.ai 的智能体之家:对话记录存在你自己的机器上，采用你能掌控的格式，随时可以带走。每一段会话都不会丢失，每一段会话都可以重新登船。

> ark-panel 正在活跃开发中，尚未达到可用于生产环境的程度。

## 当前范围

ark-panel 在本地基于 Node.js 22 运行，默认监听 `127.0.0.1`。已有的 OpenClaw 智能体会话目录作为只读数据源使用。新建的会话、派生分支、编辑后的分支，以及生成的回复，都保存在 `PANEL_DATA_DIR` 下。

面板自有会话通过独立的结构化命令接口支持 `/model`、`/think`、`/reasoning`、`/new`、
`/compact`、`/commands`、`/help`、`/status`、`/models`、`/tools` 和 `/usage`。
`/tools` 返回配置层 runtime 工具目录，不保证当前 run 一定可用其中每项；`/usage`
汇总当前权威 transcript 分支里模型上报的用量，不是账单或 tokenizer 估算。以 `/` 开头
的输入仍会被普通消息接口拒绝，也绝不会转发给网关的内联命令分发器。边界见
[斜杠命令决策](docs/decisions/slash-commands.md)。

生成运行是服务器端拥有的资源，而不是某一次浏览器请求的附属状态。面板会持久化它们的生命周期和幂等状态，允许浏览器在 SSE 连接断开后重新查询或重新订阅，并且只在一次运行确认完成后才清除草稿。OpenClaw 运行期间，面板还会转发它汇聚后的助手文本更新，以及工具的开始/完成事件，作为临时的实时预览。文本与工具卡片按上游序号交错，而不是按类型分组；工具完成时原地更新最初的卡片。这是对上游事件的转发，并不承诺每个 token 一个事件。在固定 runtime 的结果字段形状与脱敏上限通过隔离验收前，面板不会暴露实时工具结果正文。

消息文本以安全的 Markdown 渲染，禁用原始 HTML。外部 HTTP(S) Markdown 图片绝不自动请求：面板只显示 alt 文本与规范化 origin，并且仅在 hostname 与面板不同时提供显式、无来源信息的新标签链接。面板同 hostname 但不同 origin 的地址不可导航，因为浏览器 Cookie 不按端口隔离。只有既有的精确同源、需登录附件预览路由可以继续内联；相对路径与其它不安全图片目标保持不可操作。行内和块级 LaTeX 数学公式由 KaTeX 在本地渲染，不需要 CDN。整条消息和单个代码块都可以从对话视图中复制。

消息显示本地日期和时间。所有会话来源都可以重命名，也可以移入或移出归档;只读 OpenClaw 来源的元数据存放在面板单独维护的附属文件中，绝不会写回源对话记录。

### Markdown 数学公式

行内公式使用 `$...$` 或 `\(...\)`:

```markdown
恒等式 $e^{i\pi}+1=0$ 和分数 \(\frac{a}{b}\) 都是行内公式。
```

块级公式使用 `$$...$$` 或 `\[...\]`。定界符可以写在同一行，也可以让起始和结束定界符各占一行:

```markdown
$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
```

行内代码和代码块的优先级高于数学定界符，因此 `` `$not_math$` `` 会保持为代码。普通货币文本中的美元符号，如果没有构成有效的公式配对，不会被当作公式处理。无效的 LaTeX 会回退为原始文本，而不是让整条消息显示出错。复制消息或将其导出为 Markdown 时，会保留原始定界符和 LaTeX 源码。

## 功能状态

图例:✅ 已支持 · 🚧 已排期 · 💡 候选(未排期) · ⛔ 有意排除在范围外

| 领域 | 能力 | 状态 | 说明 |
| --- | --- | :---: | --- |
| 访问 | 本地账号登录与登出 | ✅ | 慢速密码哈希、安全的会话 Cookie、CSRF 与 Host/Origin 校验、登录频率限制 |
| 会话 | 浏览各智能体的活跃会话、归档会话和面板自有会话 | ✅ | OpenClaw 源对话记录保持只读 |
| 会话 | 创建并继续面板自有会话 | ✅ | 生成为每个智能体使用一个专用的、无渠道绑定的运行时 |
| 会话 | 在当前智能体内全文搜索 | ✅ | 搜索覆盖普通与归档视图；当前视图决定显示哪些结果 |
| 会话 | 重命名、归档、恢复任意会话来源 | ✅ | 只读来源使用面板单独维护的元数据附属文件 |
| 会话 | 永久删除面板会话 / 隐藏只读会话 | ✅ | 面板会话需先归档并明确确认;OpenClaw 源文件绝不删除 |
| 会话 | 按项目置顶和分组 | ✅ | 无障碍的快捷菜单可指定已有分组或就地新建;活跃与归档会话共用目录，分组在本地可折叠 |
| 分支 | 从有效的消息边界派生分支 | ✅ | 保留工具调用组，绝不修改源对话记录 |
| 分支 | 编辑一条用户消息并作为新分支重新发送 | ✅ | 原分支仍然保留 |
| 消息 | 安全的 Markdown 渲染 | ✅ | 支持标题、列表、引用、表格、链接、行内代码和代码块，原始 HTML 不执行。跨主机 HTTP(S) 图片仅可显式无来源导航，同主机异源与不安全目标保持不可操作，仅精确匹配的已认证同源附件预览可内联 |
| 消息 | LaTeX 数学公式渲染 | ✅ | KaTeX 从同源资源渲染 `$...$`、`\(...\)`、`$$...$$` 和 `\[...\]`，并带安全回退 |
| 消息 | 代码块语法高亮 | ✅ | 使用显式语言标记，显示语言名，并可安全回退为纯文本 |
| 消息 | 复制整条消息或单个代码块 | ✅ | 可直接在对话视图中操作 |
| 消息 | 本地时间戳 | ✅ | 按浏览器所在时区显示 |
| 消息 | 将当前分支导出为 Markdown | ✅ | 包含时间戳、思考、工具调用和工具结果，不含内部路径或元数据 |
| 消息 | 思考、工具调用和工具结果 | ✅ | 结构化、可折叠地渲染，包含命令输出 |
| 输入框 | 每会话的本地草稿与生成状态 | ✅ | 浏览器本地草稿在刷新和失败后仍保留;一次运行只锁定它自己的对话，其他草稿仍可编辑 |
| 输入框 | 附件与多模态输入 | ✅ | 可选择、粘贴或拖入最多 10 个受支持文件;安全的栅格图片提供草稿缩略图和需登录的消息内预览，所有文件均存放在服务器端并以原始字节发送 |
| 输入框 | 本轮文件产出意图 | ✅ | “需要文件”按会话/新会话 Agent 草稿隔离，仅作用于下一次发送，提交失败时保留 |
| 消息 | 下载模型生成的文件 | ✅ | 始终收集 OpenClaw 产物；只有本轮开启“需要文件”时才启用隔离输出目录兜底；下载需要面板身份认证 |
| 对话 | 长会话滚动跟随 | ✅ | 保留阅读位置，并在用户向上滚动时显示新消息提示 |
| 生成 | 持久的运行生命周期、重连、停止、重试和幂等发送 | ✅ | 服务器端拥有的运行状态在浏览器断连后仍存续;SSE 可重新订阅，完成的消息组以原子方式提交 |
| 生成 | 有序的实时助手文本与工具状态 | ✅ | 按上游序号交错汇聚文本与工具卡片，重复/重放事件保持幂等;不流式传输工具 stdout/结果正文与推理过程 |
| 上下文 | 可配置的上下文预算保护 | ✅ | 在生成前拒绝过大的请求，而不是悄悄截断历史 |
| 上下文 | 持久压缩与 `/compact` | ✅ | 手动 `/compact` 与界面操作会持久采纳经验证的 OpenClaw 摘要且不删除历史；有效预算、压缩标记、fork/导出和可选的先整理记忆流程均已完成 |
| 命令 | `/model`、`/think`、`/reasoning`、`/new` | ✅ | 面板原生的结构化操作;命令文本绝不作为普通提示词转发 |
| 命令 | `/commands`、`/help`、`/status`、`/models`、`/tools`、`/usage` | ✅ | 只读的结构化命令接口，采用默认拒绝的允许列表;tools 为配置的运行时目录，usage 为当前对话分支的模型上报数据 |
| 命令 | `/reset`、`/bash`、配置/重启，以及任意透传 | ⛔ | 因生命周期、主机和网关安全风险而有意排除 |
| 记忆 | 存储每会话的 `scratch` / `eligible` 处置状态 | ✅ | 默认为 `scratch`;两种状态采用相同的聊天 runtime 记忆配置合同，只有 eligible 可进入面板沉淀流程；实际召回能力依 runtime 而定且当前未知 |
| 记忆 | 处置界面与只读记忆中心 | ✅ | 齿轮上方直接进入按 Agent 切换的树状页面与 Markdown 阅读区，安全查看允许的记忆文件并跳回来源会话 |
| 记忆 | 面板管理的记忆整理流程 | ✅ | eligible 会话的候选、确认、滚动文件与恢复事务已实现；真实模型执行、有效工具和三份索引刷新在 #48 前未知 |
| 外观 | 可切换主题与命名强调色 | ✅ | 系统/浅色/深色，外加 Gruvbox hard/medium/soft 的浅色和深色变体;账号级、跨设备;所有内置强调色组合均满足 WCAG AA |
| 外观 | 设置抽屉 | ✅ | 齿轮图标直接打开外观/阅读设置;登出留在底部;账号偏好在服务器端持久化 |
| 外观 | 每个智能体的自定义头像 | ✅ | 1:1 裁剪预览、限制大小的位图上传、服务器端校验/重新编码、恢复默认，以及账号级共享 |
| 外观 | 可调的阅读字号 | ✅ | 设备本地的 85%–130% 滑块，作用于消息、Markdown、代码、工具和数学公式，不影响导航/布局缩放 |
| 外观 | 对话状态(模型覆盖、上下文用量、最近活跃) | ✅ | 紧凑的头部摘要;账号级服务器设置可跨设备隐藏;上下文只采用新鲜的 OpenClaw 模型上报用量，否则显示未知，保守估算仅用于发送保护 |
| 会话 | 可折叠的侧栏 | ✅ | 折叠两侧桌面侧栏，仍保留新建会话、搜索、10 条最近会话、设置和智能体切换;移动端流程仍为全屏 |
| 生成 | 后台完成通知 | ✅ | 每会话、设备本地的未读状态，跨智能体/列表标记，以及并发运行时的标题计数;失败会通知，用户主动中止不通知 |
| 对话 | 文档标题反映会话与智能体 | ✅ | 格式为 `会话 - 智能体`;同时带有后台完成标记 |
| 导航 | 键盘快捷键与命令面板 | 💡 | 候选，未排期;未来版本必须可配置、可关闭，以兼容 Vimium |
| 本地化 | 简体中文与英文界面 | ✅ | 轻量的语义键值目录;账号级语言设置随用户跨设备生效，旧设置回退为中文 |
| 访问 | 界面内修改密码 | ⛔ | 保持仅限命令行(`npm run password-hash`);登出仍位于设置抽屉底部 |
| 运维 | 备份、完整性校验、恢复、健康检查和 systemd 示例 | ✅ | 包含部署冒烟测试和基于固定用例的浏览器验收覆盖 |

外观、侧栏、头像、标题、对话状态、后台完成、双语界面、面板自有的可审阅记忆流程
和手动持久长上下文策略均已提供。配置合同为 `scratch` 与 `eligible` 聊天采用相同的
workspace/bootstrap/tool 策略，只有 `eligible` 进入面板沉淀流程；特定 runtime 是否
实际注入并召回记忆在 #48 前未知。压缩不会删除面板完整 transcript，也不会自动静默
执行。终态 run 目前无限期保留以维持
幂等语义；回收策略必须另行设计长期 tombstone。详细边界见
[记忆模块决定](docs/decisions/panel-memory.md)。OpenClaw 兼容性保持版本门禁。真实 runtime、
bootstrap、memory、proxy/TLS 和部署后的 SSE 当前状态，在当前矩阵记录的 #48 受控验收
完成前均为未知；日期化证据不是永久保证。体验功能的取舍理由见
[体验功能决策记录](docs/decisions/ux-features.md)；详细的约束和验收标准见
[实现规格说明](docs/implementation-spec.md)。

## 安装与测试

```sh
npm ci
npm run check:frontend
npm test
npm run test:coverage
```

可执行的覆盖率范围、阈值、排除项和浏览器边界见[覆盖率基线](docs/coverage.md)。

生成密码哈希:

```sh
npm run password-hash -- 'replace-with-your-password'
```

## 配置

密钥应放在环境变量中，绝不要写入仓库:

```sh
export PANEL_USERNAME='panel-user'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='a-random-secret-with-at-least-32-characters'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
# 为一个 HTTPS 反代入口成对设置：
# export PANEL_PUBLIC_ORIGIN='https://panel.example.com'
# export PANEL_SECURE_COOKIE='1'
# 仅当代理改写 Host 时，可选填额外精确 Host（JSON 数组）：
# export PANEL_TRUSTED_HOSTS='["panel-internal.example.com"]'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'
# 可选:关闭实时预览，同时保留持久的生成过程和 SSE 生命周期事件。
export PANEL_OPENCLAW_STREAMING='1'

export PANEL_READ_AGENTS='{
  "assistant":{"label":"Assistant","sessionsRoot":"/srv/openclaw/agents/assistant/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "assistant":{"runtimeAgentId":"panel-runtime-assistant","sessionsRoot":"/srv/openclaw/agents/panel-runtime-assistant/sessions","workspaceRoot":"/srv/openclaw/workspaces/assistant"}
}'
export PANEL_MEMORY_RUNTIMES='{
  "assistant":{"runtimeAgentId":"panel-memory-assistant","sessionsRoot":"/srv/openclaw/agents/panel-memory-assistant/sessions"}
}'
```

`PANEL_READ_AGENTS` 是允许浏览的真实智能体的允许列表。`PANEL_AGENT_RUNTIMES` 把每个可浏览的智能体映射到一个没有渠道绑定的专用运行时;绝不要把真实的、绑定了渠道的智能体用作面板运行时。为每个受信任的 `workspaceRoot` 设置路径，即可开启按需的输出目录兜底与只读记忆中心。浏览器只能为本轮请求文件，无法选择这个路径。

`PANEL_MEMORY_RUNTIMES` 是可选配置，用于开启经用户审阅的记忆整理。每项必须指向独立、无渠道绑定的 `panel-memory-*` OpenClaw agent，并让它与对应 `workspaceRoot` 使用同一 workspace。该 agent 应不配置工具，或只保留 `memory_search` 与 `memory_get`；ark-panel 创建每个内部 session 后都会检查其逐会话有效工具清单，发现其它工具就拒绝运行。不能复用普通聊天 runtime。配置和这道失败关闭门禁都不能证明某个 runtime 的 bootstrap、记忆召回、模型执行或索引刷新可用；它们在 #48 记录受控结果前均为未知。

上传的文件存放在 `PANEL_DATA_DIR/files` 下，采用内容寻址的私有存储，并纳入常规备份。Office 文件有意不做转换:OpenClaw 收到原始文件，模型可以用自己的 Python/技能工具去检视。面板始终收集 OpenClaw 的本轮运行产物，且不会为此改写用户消息。只有输入框本轮开启“需要文件”时，服务端才会在配置的工作区下创建 `.openclaw/tmp/ark-panel/<run-id>/outputs`，并把对应产出指令附加到发送给 runtime 的本轮消息。文件复制进面板存储后再删除临时目录。符号链接、硬链接、特殊文件、路径逃逸、过多的文件数量和过大的体积都会被拒绝。

长时间运行的智能体工作默认有 30 分钟的 OpenClaw 执行上限(`PANEL_GATEWAY_RUN_TIMEOUT_MS`)。面板随后会额外等待 30 秒(`PANEL_RUN_WATCHER_GRACE_MS`)以接收终止的轨迹事件，这样上游的超时或中止能被准确报告，而不会被面板同时发生的超时所掩盖。

面板复用服务器端一条到本机 OpenClaw Gateway 的控制 WebSocket，同时让浏览器只连接面板已认证的 SSE 端点；Gateway 凭据绝不会发送到浏览器。对固定适配的 OpenClaw `2026.6.11`，连接身份为 `gateway-client/backend`、角色为 `operator`，且只请求 `operator.read`、`operator.write`、`operator.admin` 这三个 scope；`hello` 授权缺项、重复或多出任何 scope 都会被拒绝。read 用于状态/目录/session 观察和 artifact 收集，write 用于创建临时 session、发送消息（包括 Base64 附件）与停止，admin 用于 session override、压缩和删除。显式、版本化的 RPC 允许列表会在发帧前本地拒绝任何未经评审的方法。

控制连接 resolver 只加载一份严格 JSON 的 OpenClaw 配置。`PANEL_OPENCLAW_CONFIG_PATH` 是声明 `OPENCLAW_PROFILE` 时唯一可显式指定配置的 selector；没有它时，任何已声明 profile 都在考虑 `OPENCLAW_CONFIG_PATH`、state、home 或 legacy selector 前 fail closed。否则顺序为官方 `OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR` 下的 `openclaw.json` / `clawdbot.json`、`OPENCLAW_HOME` 下的四个默认/legacy 候选，最后是兼容旧版的 `OPENCLAW_CONFIG`。空白显式路径直接拒绝；目录 selector 仅在候选不存在时继续同目录的下一个候选，绝不落到低优先级 selector，已找到文件不可读或解析失败即拒绝。未声明 selector 时，才在 OS home 下依次查找 `~/.openclaw/openclaw.json`、`~/.openclaw/clawdbot.json`、`~/.clawdbot/openclaw.json`、`~/.clawdbot/clawdbot.json`。当前兼容层拒绝 JSON5，也拒绝严格 JSON 树中任何 `$include` 或未转义的 `${VAR}`，绝不部分解释；`$${VAR}` 保持字面量。解析/定位失败只影响 Gateway 控制可用性，绝不暴露配置正文或路径。

本机端点的 scheme 来自 `gateway.tls.enabled`。port 优先级为已声明且非空合法的 `OPENCLAW_GATEWAY_PORT`、合法的 `gateway.port`、最后默认 `18789`；环境变量一旦声明为空白或非法就 fail closed，不向后回落。对同一端点，显式 `mode=none` 即使残留字段或面板环境凭据也始终禁用连接；`token` 和 `password` 模式只采用对应字段；未写 mode 时仅在恰有一种凭据时推导。`trusted-proxy` 仅在同机 password fallback 满足以下全部条件时接受：`gateway.auth.trustedProxy.userHeader` 非空白、`gateway.trustedProxies` 是元素均非空白的非空列表、配置中没有 token、未声明 `PANEL_OPENCLAW_GATEWAY_TOKEN`，并且最终选中非空 password；连接只发送 password。声明 `PANEL_OPENCLAW_GATEWAY_TOKEN` / `PASSWORD` 只覆盖该已知 mode 选中的凭据，整组全为空白时 fail closed，不回落配置文件。SecretRef 字符串或对象会参与 mode、歧义和互斥判断，但面板有意不执行 env/file/exec secret provider；选中的 SecretRef 必须有对应的非空 `PANEL_*` 明文覆盖，否则控制面保持不可用，错误和日志也不会记录 ref 细节。完整 provider 解析需另行评审集成。

remote mode 与本机 `gateway.auth` 完全独立，且绝不回落本机默认端点。配置型 remote 端点必须有非空且传输安全的 `gateway.remote.url`、显式 `transport: "direct"`、未配置 `tlsFingerprint`；未声明面板凭据覆盖时只使用 `gateway.remote` 凭据。非空面板凭据组可覆盖这些凭据值，但不会改变端点 provenance 或绕过 transport 门禁。若声明的 `PANEL_OPENCLAW_GATEWAY_URL` 与配置 remote URL 的带类型 origin 相同，还必须同时声明该面板凭据组；它仍属于配置型 remote provenance，因此继续要求 `direct` 且无 fingerprint。面板不创建 SSH tunnel，也不实现 fingerprint pin；direct TLS 使用宿主机正常证书校验。只有面板 URL 指向不同 origin，或配置 remote URL 缺失时，它才可成为自包含的独立端点；此时必须同时提供非空面板凭据组，且不继承任何磁盘 secret、transport 或 pin 假设。本机模式下，若面板 URL 改变带类型的 WebSocket origin（scheme、规范化 host 类型或 port），也必须使用独立凭据；各 loopback 别名可视为同一主机，但名为 `loopback` 的普通 DNS hostname 绝不会与本机 sentinel 混同。公网端点必须使用 `wss://`；明文 `ws://` 仅允许 loopback、私网/link-local/CGNAT/ULA 字面地址以及 `.local`、`.ts.net`，与固定版本的默认传输策略一致。TLS 证书校验始终开启，自签或私有 CA 端点必须先由宿主机信任。端点断言不会改变目标 Gateway 服务端 auth mode，只能与确实强制相同 token/password 的配置同步部署，并留待 #48 验证。

最终选中的共享密钥是单一受信 operator 的 owner 级凭据，不是多租户隔离边界，并应保留默认 loopback。轮换时同步更新 Gateway 与面板并重启两端，回滚时也同步恢复；启用当前精确 scope 握手本身不要求重新签发凭据。若服务端无法解析合法的配置、端点、transport 或凭据，面板只读访问仍可用，所有 Gateway 控制操作以稳定的 `GATEWAY_TRANSPORT_UNAVAILABLE` 失败；错误和日志不会暴露凭据、SecretRef 细节、配置正文或选中的私有路径，生产也不会回落为逐请求 Gateway CLI 连接。`PANEL_OPENCLAW_STREAMING=0` 只关闭临时文本/工具预览，同一控制 WebSocket 和三个 scope 仍用于生成、typed 命令、附件和临时 session 生命周期。预览失败不能决定 run 是否完成，但控制连接不可用时，需要 Gateway RPC 的操作会失败。经过校验的完整 transcript 始终是权威版本，并以原子方式替换任何预览。

构建并启动:

```sh
npm run build
npm start
```

检查无需认证的健康检查端点:

```sh
npm run healthcheck
```

运行确定性的 Firefox/WebDriver 浏览器验收（需要 `PATH` 中存在 Firefox
和 geckodriver）：

```sh
npm run test:browser
```

### HTTPS 反向代理

应用仍然只监听 `127.0.0.1`，由反向代理终止 TLS。配置唯一一个浏览器可见
origin，并开启安全 Cookie：

```sh
export PANEL_PUBLIC_ORIGIN='https://panel.example.com'
export PANEL_SECURE_COOKIE='1'
```

`PANEL_PUBLIC_ORIGIN` 必须精确为 `http(s)://host[:port]`，不能带末尾斜杠、
userinfo、路径、查询、fragment 或 wildcard；它规范化后的 Host 会自动进入信任
列表。`PANEL_TRUSTED_HOSTS` 是可选 JSON 数组，最多 16 个值，只用于代理明确
改写 `Host` 时补充精确 Host，通常不应设置。规范化后的重复项、IDN/punycode
域名、替代数字 IP 写法和非规范 IPv6 写法都会在启动时被拒绝。只支持一个外部
origin。

例如，在 nginx 的 TLS server 配置中加入以下完整入口（证书路径替换为部署的
实际路径）：

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/ssl/ark-panel/fullchain.pem;
    ssl_certificate_key /etc/ssl/ark-panel/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

面板分别校验实际 `Host` 与浏览器 `Origin`，不会读取 `X-Forwarded-Host`、
`X-Forwarded-Proto`、`Forwarded` 或其它代理头，因此伪造这些头不能扩大信任
边界。缺失或为 `null` 的 Origin 仍会让登录和修改请求失败，既有 CSRF token
也仍然必需。不设置这些变量时，本机与 SSH 端口转发的 HTTP 默认行为保持不变。

当前固定适配 OpenClaw `2026.6.11`;升级 OpenClaw 前请重新运行集成验收。

## 文档

- [架构](docs/architecture.md)
- [实现规格说明](docs/implementation-spec.md)
- [工程决策](docs/decisions/engineering-decisions.md)
- [文档角色与索引](docs/README.md)
- [已取代的版本 1 上线清单](docs/v1-completion.md)
- [当前支持与验收矩阵](docs/testing/README.md)
- [运行时验收 runbook](docs/testing/runtime-acceptance.md)
- [日期化流式验收证据](docs/testing/streaming-acceptance.md)
- [日期化浏览器验收证据](docs/testing/browser-acceptance.md)
- [开发存档](docs/archive/development-notes/)

## 许可证

ark-panel 以 [MIT 许可证](LICENSE)提供。
