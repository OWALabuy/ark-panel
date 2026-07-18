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

面板自有的会话通过一套独立的结构化命令接口支持 `/model`、`/think`、`/reasoning`、`/new`、`/commands`、`/help`、`/status` 和 `/models`。以 `/` 开头的输入仍会被普通的消息接口拒绝，绝不会被转发到网关的内联命令分发器。边界的划分见[斜杠命令的决策记录](docs/decisions/slash-commands.md)。

生成运行是服务器端拥有的资源，而不是某一次浏览器请求的附属状态。面板会持久化它们的生命周期和幂等状态，允许浏览器在 SSE 连接断开后重新查询或重新订阅，并且只在一次运行确认完成后才清除草稿。OpenClaw 运行期间，面板还会转发它汇聚后的助手文本更新，以及工具的开始/完成事件，作为临时的实时预览。这是对上游事件的转发，并不承诺每个 token 一个事件。

消息文本以安全的 Markdown 渲染，禁用原始 HTML。行内和块级 LaTeX 数学公式由 KaTeX 在本地渲染，不需要 CDN。整条消息和单个代码块都可以从对话视图中复制。

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
| 会话 | 全文搜索，并按来源/智能体筛选 | ✅ | 搜索包含归档会话;当前视图决定显示哪些结果 |
| 会话 | 重命名、归档、恢复任意会话来源 | ✅ | 只读来源使用面板单独维护的元数据附属文件 |
| 会话 | 永久删除面板会话 / 隐藏只读会话 | ✅ | 面板会话需先归档并明确确认;OpenClaw 源文件绝不删除 |
| 会话 | 按项目置顶和分组 | ✅ | 无障碍的快捷菜单可指定已有分组或就地新建;活跃与归档会话共用目录，分组在本地可折叠 |
| 分支 | 从有效的消息边界派生分支 | ✅ | 保留工具调用组，绝不修改源对话记录 |
| 分支 | 编辑一条用户消息并作为新分支重新发送 | ✅ | 原分支仍然保留 |
| 消息 | 安全的 Markdown 渲染 | ✅ | 标题、列表、引用、表格、链接、行内代码和代码块;不执行原始 HTML |
| 消息 | LaTeX 数学公式渲染 | ✅ | KaTeX 从同源资源渲染 `$...$`、`\(...\)`、`$$...$$` 和 `\[...\]`，并带安全回退 |
| 消息 | 代码块语法高亮 | ✅ | 使用显式语言标记，显示语言名，并可安全回退为纯文本 |
| 消息 | 复制整条消息或单个代码块 | ✅ | 可直接在对话视图中操作 |
| 消息 | 本地时间戳 | ✅ | 按浏览器所在时区显示 |
| 消息 | 将当前分支导出为 Markdown | ✅ | 包含时间戳、思考、工具调用和工具结果，不含内部路径或元数据 |
| 消息 | 思考、工具调用和工具结果 | ✅ | 结构化、可折叠地渲染，包含命令输出 |
| 输入框 | 每会话的本地草稿与生成状态 | ✅ | 浏览器本地草稿在刷新和失败后仍保留;一次运行只锁定它自己的对话，其他草稿仍可编辑 |
| 输入框 | 附件与多模态输入 | ✅ | 可选择、粘贴或拖入最多 10 个受支持文件;安全的栅格图片提供草稿缩略图和需登录的消息内预览，所有文件均存放在服务器端并以原始字节发送 |
| 消息 | 下载模型生成的文件 | ✅ | 收集 OpenClaw 产物和写入当前运行隔离输出目录的文件;下载需要面板身份认证 |
| 对话 | 长会话滚动跟随 | ✅ | 保留阅读位置，并在用户向上滚动时显示新消息提示 |
| 生成 | 持久的运行生命周期、重连、停止、重试和幂等发送 | ✅ | 服务器端拥有的运行状态在浏览器断连后仍存续;SSE 可重新订阅，完成的消息组以原子方式提交 |
| 生成 | 实时助手文本与工具状态 | ✅ | 转发 OpenClaw 汇聚后的更新(当前约每 150 毫秒一次)，而非每个 token 一个事件;不流式传输工具标准输出和推理过程 |
| 上下文 | 可配置的上下文预算保护 | ✅ | 在生成前拒绝过大的请求，而不是悄悄截断历史 |
| 上下文 | 持久压缩与 `/compact` | 🚧 | 作为长会话策略一并规划;摘要边界和分支行为仍需完成设计 |
| 命令 | `/model`、`/think`、`/reasoning`、`/new` | ✅ | 面板原生的结构化操作;命令文本绝不作为普通提示词转发 |
| 命令 | `/commands`、`/help`、`/status`、`/models`、`/tools`、`/usage` | ✅ | 只读的结构化命令接口，采用默认拒绝的允许列表;tools 为配置的运行时目录，usage 为当前对话分支的模型上报数据 |
| 命令 | `/reset`、`/bash`、配置/重启，以及任意透传 | ⛔ | 因生命周期、主机和网关安全风险而有意排除 |
| 记忆 | 存储每会话的 `scratch` / `eligible` 处置状态 | ✅ | 默认为 `scratch`;该控件尚未在界面中开放 |
| 记忆 | 记忆处置界面与推理期间的 scratch 隔离 | 🚧 | 隔离行为将通过 `paneltest` 运行时验收来确定 |
| 外观 | 可切换主题与命名强调色 | ✅ | 系统/浅色/深色，外加 Gruvbox hard/medium/soft 的浅色和深色变体;账号级、跨设备;所有内置强调色组合均满足 WCAG AA |
| 外观 | 设置抽屉 | ✅ | 齿轮图标直接打开外观/阅读设置;登出留在底部;账号偏好在服务器端持久化 |
| 外观 | 每个智能体的自定义头像 | ✅ | 1:1 裁剪预览、限制大小的位图上传、服务器端校验/重新编码、恢复默认，以及账号级共享 |
| 外观 | 可调的阅读字号 | ✅ | 设备本地的 85%–130% 滑块，作用于消息、Markdown、代码、工具和数学公式，不影响导航/布局缩放 |
| 外观 | 对话状态(模型覆盖、上下文安全预算、最近活跃) | ✅ | 紧凑的头部摘要;账号级服务器设置可跨设备隐藏;上下文明确标注为面板的保守估算 |
| 会话 | 可折叠的侧栏 | ✅ | 折叠两侧桌面侧栏，仍保留新建会话、搜索、10 条最近会话、设置和智能体切换;移动端流程仍为全屏 |
| 生成 | 后台完成通知 | ✅ | 每会话、设备本地的未读状态，跨智能体/列表标记，以及并发运行时的标题计数;失败会通知，用户主动中止不通知 |
| 对话 | 文档标题反映会话与智能体 | ✅ | 格式为 `会话 - 智能体`;同时带有后台完成标记 |
| 导航 | 键盘快捷键与命令面板 | 💡 | 候选，未排期;未来版本必须可配置、可关闭，以兼容 Vimium |
| 本地化 | 简体中文与英文界面 | ✅ | 轻量的语义键值目录;账号级语言设置随用户跨设备生效，旧设置回退为中文 |
| 访问 | 界面内修改密码 | ⛔ | 保持仅限命令行(`npm run password-hash`);登出仍位于设置抽屉底部 |
| 运维 | 备份、完整性校验、恢复、健康检查和 systemd 示例 | ✅ | 包含部署冒烟测试和基于固定用例的浏览器验收覆盖 |

外观、侧栏、头像、标题、对话状态、后台完成和双语界面这几批工作已经完成。近期的顺序回到记忆处置界面与 scratch 隔离，随后是带 `/compact` 的持久长上下文策略。OpenClaw 兼容性属于持续的日常维护。体验功能的取舍理由见[体验功能决策记录](docs/decisions/ux-features.md);详细的约束和验收标准见[实现规格说明](docs/implementation-spec.md)。

## 安装与测试

```sh
npm ci
npm test
```

生成密码哈希:

```sh
npm run password-hash -- 'replace-with-your-password'
```

## 配置

密钥应放在环境变量中，绝不要写入仓库:

```sh
export PANEL_USERNAME='owl'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='a-random-secret-with-at-least-32-characters'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'
# 可选:关闭实时预览，同时保留持久的生成过程和 SSE 生命周期事件。
export PANEL_OPENCLAW_STREAMING='1'

export PANEL_READ_AGENTS='{
  "claude":{"label":"Claude","sessionsRoot":"/home/USER/.openclaw/agents/claude/sessions"},
  "main":{"label":"Main","sessionsRoot":"/home/USER/.openclaw/agents/main/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "claude":{"runtimeAgentId":"panel-runtime-claude","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-claude/sessions","workspaceRoot":"/home/USER/claude"},
  "main":{"runtimeAgentId":"panel-runtime-main","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-main/sessions","workspaceRoot":"/home/USER/clawd"}
}'
```

`PANEL_READ_AGENTS` 是允许浏览的真实智能体的允许列表。`PANEL_AGENT_RUNTIMES` 把每个可浏览的智能体映射到一个没有渠道绑定的专用运行时;绝不要把真实的、绑定了渠道的智能体用作面板运行时。为每个受信任的 `workspaceRoot` 设置路径，即可开启模型输出下载。浏览器无法选择这个路径。

上传的文件存放在 `PANEL_DATA_DIR/files` 下，采用内容寻址的私有存储，并纳入常规备份。Office 文件有意不做转换:OpenClaw 收到原始文件，模型可以用自己的 Python/技能工具去检视。模型输出只接受来自 OpenClaw 运行产物，或配置的工作区下 `.openclaw/tmp/ark-panel/<run-id>/outputs` 目录的文件，随后复制进面板存储，再删除那个临时目录。符号链接、硬链接、特殊文件、路径逃逸、过多的文件数量和过大的体积都会被拒绝。

长时间运行的智能体工作默认有 30 分钟的 OpenClaw 执行上限(`PANEL_GATEWAY_RUN_TIMEOUT_MS`)。面板随后会额外等待 30 秒(`PANEL_RUN_WATCHER_GRACE_MS`)以接收终止的轨迹事件，这样上游的超时或中止能被准确报告，而不会被面板同时发生的超时所掩盖。

实时预览通过服务器端一条独立的 WebSocket 连接连到本地的 OpenClaw 网关，同时让浏览器保持在面板已认证的 SSE 端点上;网关凭据绝不会发送到浏览器。默认情况下，面板从 `~/.openclaw/openclaw.json` 读取本地 URL 和令牌/密码。`PANEL_OPENCLAW_GATEWAY_URL`、`PANEL_OPENCLAW_GATEWAY_TOKEN` 和 `PANEL_OPENCLAW_GATEWAY_PASSWORD` 会覆盖这些值，`PANEL_OPENCLAW_STREAMING=0` 则关闭预览。该连接请求 `operator.read` 用于观测，`operator.write` 用于结构化附件发送;Base64 文件通过 WebSocket 发送，而不是走有大小限制的命令行参数。如果观测连接断开，普通文本生成仍会通过既有的 CLI/轨迹路径继续，界面回退到非流式的等待状态;附件发送则需要已认证的 WebSocket 传输。经过校验的完整对话记录始终是权威版本，并以原子方式替换预览。

构建并启动:

```sh
npm run build
npm start
```

检查无需认证的健康检查端点:

```sh
npm run healthcheck
```

通过 HTTPS 反向代理提供服务时，设置 `PANEL_SECURE_COOKIE=1`。首个版本固定适配 OpenClaw `2026.6.11`;升级 OpenClaw 前请重新运行集成验收。

## 文档

- [架构](docs/architecture.md)
- [实现规格说明](docs/implementation-spec.md)
- [工程决策](docs/decisions/engineering-decisions.md)
- [版本 1 完成状态](docs/v1-completion.md)
- [运行时验收流程](docs/testing/runtime-acceptance.md)
- [流式协议验收](docs/testing/streaming-acceptance.md)
- [浏览器验收结果](docs/testing/browser-acceptance.md)
- [开发存档](docs/archive/development-notes/)

随着首次生产部署的完成，运维和验收文档仍在整理合并中。

## 许可证

ark-panel 以 [MIT 许可证](LICENSE)提供。
