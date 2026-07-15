# ark-panel

本地会话面板服务。Node.js 22，默认只监听 `127.0.0.1`。真实 OpenClaw agent 的 sessions 目录只作为只读数据源；所有新建、fork、编辑重发和后续推理结果只写入 `PANEL_DATA_DIR`。

面板自建 / fork 会话支持首批面板原生命令和只读信息命令。普通消息接口仍会在调用 gateway 前拒绝以 `/` 开头的输入；命令必须走独立结构化派发接口。支持范围和隔离原则见[斜杠命令决定](../decisions/slash-commands.md)。

首版已完成能力、明确不做的范围和上线前需要用户参与的事项见 [首版完成状态](../v1-completion.md)。当前 SSE 提供 run 生命周期状态，gateway 完成后整组刷新消息，不宣称逐 token 输出。

## 安装与测试

```sh
npm ci
npm test
```

生成密码哈希：

```sh
npm run password-hash -- '替换为实际密码'
```

## 配置

所有秘密通过环境变量传入，不要写进仓库：

```sh
export PANEL_USERNAME='owl'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='至少32字符的随机秘密'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'

export PANEL_READ_AGENTS='{
  "claude":{"label":"Claude","sessionsRoot":"/home/USER/.openclaw/agents/claude/sessions"},
  "main":{"label":"Main","sessionsRoot":"/home/USER/.openclaw/agents/main/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "claude":{"runtimeAgentId":"panel-runtime-claude","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-claude/sessions"},
  "main":{"runtimeAgentId":"panel-runtime-main","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-main/sessions"}
}'
```

`PANEL_READ_AGENTS` 是可浏览的真实 agent allowlist。`PANEL_AGENT_RUNTIMES` 把面板会话所属 agent 映射到无渠道绑定的专用推理 agent；禁止把真实 agent 本身配置成 runtime。`paneltest` 只允许用于显式集成测试。

启动：

```sh
npm run build
npm start
```

启动时会执行配置安全检查并初始化数据目录：

- `PANEL_DATA_DIR` 自动创建并收紧为 `0700`；
- read、runtime、data 目录不得相同或存在父子重叠；
- runtime 路径必须与其 agent ID 对应，且不能是符号链接；
- 静态资源路径按程序安装位置解析，不依赖启动时的 cwd。

健康检查无需登录：

```sh
npm run healthcheck
# 或 curl --fail http://127.0.0.1:8790/api/v1/health
```

如经 HTTPS 反向代理访问，设置 `PANEL_SECURE_COOKIE=1`。第一版固定支持 OpenClaw `2026.6.11`，升级 OpenClaw 前应重跑集成测试。

## 数据与并发语义

- `GET /api/v1/sessions` 返回每条记录的 `revision` 和 `updatedAt`。
- `GET /api/v1/revisions?agentId=...` 提供轻量轮询数据。
- 新建 panel 会话：`POST /api/v1/sessions`，请求体为 `{ "agentId": "claude", "title": "可选标题" }`。
- 生成消息时可在请求体带当前 `revision`；版本不一致会拒绝写入。
- 同一 panel 会话同一时刻只允许一轮生成。
- 客户端重试应复用 UUID 格式的 `Idempotency-Key`。相同 key 与相同消息会共享或返回已完成结果；把同一 key 用于不同消息会被拒绝。
- fork 和编辑重发只创建新的 panel 会话，不修改来源 transcript。
- conversation API 只返回允许的 header/entry 字段，不返回 workspace `cwd` 或未知 header 字段。
- run 状态和幂等结果持久化在 panel 数据目录中；服务重启后客户端可用原 `Idempotency-Key` 重连或读取已完成结果。

gateway 单轮执行默认最多等待 30 分钟，随后再给轨迹观察器 30 秒收尾窗口，分别由
`PANEL_GATEWAY_RUN_TIMEOUT_MS` 和 `PANEL_RUN_WATCHER_GRACE_MS` 调整。用户停止、超时或服务启动时清理遗留 run，
都必须确认 OpenClaw 已释放对应运行槽位后才能删除临时 session；若无法确认，面板会保留清理信息并报告失败，
不会把它误报为“已停止”。

## 第一版长上下文保护

面板在创建 gateway 临时 session 之前，对“完整历史 + 本轮用户消息”执行保守预算检查。默认历史预算为 `100000` tokens，可通过 `PANEL_CONTEXT_HISTORY_BUDGET_TOKENS` 调整（至少 1024）。

当前估算器是稳定、可测试的 `utf8-bytes-upper-bound-v2`：以序列化 transcript 的 UTF-8 字节数作为 token 数上界，再为每个 entry 加固定结构开销。它不是模型官方 tokenizer，会明显高估普通文本，但不会像“字节数除以固定比例”那样低估高熵 ASCII；预算只覆盖面板提供的历史，默认值还为 gateway 额外注入的系统提示、记忆、工具定义和模型输出留出空间。

若估算超过预算，推理不会触达 gateway，panel transcript 也不会写入本轮 user entry。SSE 返回稳定错误码 `CONTEXT_BUDGET_EXCEEDED`、估算值和中文处理建议。第一版不会自动截断内容，也不会生成未经模型确认的“摘要”；用户需要从较早位置 fork，或等待后续正式压缩功能。

调整预算时应同时考虑所用模型上下文窗口、runtime 系统提示和工具集合大小。把值设得接近模型最大窗口并不安全。

## systemd 用户服务

仓库提供 [../../deploy/ark-panel.service](../../deploy/ark-panel.service) 示例。它固定使用 `127.0.0.1` 上的应用服务、从独立 `EnvironmentFile` 读取配置，并把真实会话目录声明为只读。

1. 复制示例到 `~/.config/systemd/user/ark-panel.service`，替换其中的 `USER`、仓库路径和专用 runtime 目录。
2. 建立 `~/.config/ark-panel/panel.env`，权限设为 `0600`；该文件包含账号、密码哈希和 session secret，不能提交到 git。
3. 确保数据目录为 `0700`，runtime sessions 目录只属于当前用户；不要把真实 agent sessions 放进 `ReadWritePaths`。
4. Node 若不在 systemd 默认 `PATH` 中，在 EnvironmentFile 设置受控的 `PATH`，或把 `ExecStart` 改成 Node 22 的绝对路径。
5. 启动并检查：

```sh
systemctl --user daemon-reload
systemctl --user enable --now ark-panel.service
systemctl --user status ark-panel.service
curl --fail http://127.0.0.1:8790/api/v1/health
```

服务示例启用了 `UMask=0077`、`NoNewPrivileges`、只读 home/system 防护和显式可写目录。若实际 agent 名或数据路径不同，必须同步调整 `ReadOnlyPaths` / `ReadWritePaths`，否则服务应当启动失败，而不是放宽整个 home 的写权限。

建议给 unit 增加启动后的健康检查，并让失败状态可被 systemd 观察：

```ini
[Service]
ExecStartPost=/usr/bin/curl --retry 10 --retry-delay 1 --retry-connrefused --fail http://127.0.0.1:8790/api/v1/health
Restart=on-failure
RestartSec=3
```

部署前先手工执行一次 `npm run build && npm test`。更新时先停止服务、完成离线备份，再替换代码并启动；若启动健康检查失败，恢复旧代码和一个已校验的新数据目录。不要在服务运行、可能正在提交 transcript 时做文件级备份。

仓库还提供完全临时、不会配置 OpenClaw agent 或调用模型的生产流程 dry-run。它会构造 fixture 数据源，实际启动 Node 服务并验证 health、登录、写入、SIGTERM 优雅停止、重启持久性、离线 backup/verify/restore，以及从恢复目录再次启动读取；结束时删除全部临时目录和子进程：

```sh
npm run test:deployment
```

主进程收到 SIGTERM/SIGINT 后会停止接受新连接，并给现有连接最多 10 秒完成。示例 unit 的 `TimeoutStopSec=15` 为应用清理留出余量；超时应视为异常退出并由运维检查日志，而不是使用无限停止时间。

## 离线备份、恢复与迁移

备份工具只处理 `PANEL_DATA_DIR`，不会连接 gateway，也显式拒绝 `.openclaw/agents/...` 路径。操作前应停止用户服务，以得到同一时点的一致快照：

```sh
systemctl --user stop ark-panel.service
cd /home/USER/awa/ark-panel
npm run build
mkdir -m 700 -p "$HOME/.local/backup/ark-panel"
npm run backup -- backup "$PANEL_DATA_DIR" "$HOME/.local/backup/ark-panel" before-upgrade
npm run backup -- verify "$HOME/.local/backup/ark-panel/before-upgrade"
```

每份备份含逐文件大小/SHA-256 和空目录清单的 `manifest.json`。工具拒绝 symlink、特殊文件、路径越界、源/目标重叠、已有同名备份，以及超过清单、条目、单文件或总字节上限的输入；先在备份根下完成权限为 `0700/0600` 的临时树并同步，再原子改名发布。恢复使用目标名锁避免并发操作，在实际复制时逐文件再次核对大小和哈希，并复核目标父目录身份；恢复目标仍必须不存在。

恢复永远写入一个不存在的新目录，校验全部文件后才原子就位，不覆盖现有数据：

```sh
npm run backup -- restore "$HOME/.local/backup/ark-panel/before-upgrade" "$HOME/.local/share/ark-panel-restored"
```

随后把 `PANEL_DATA_DIR` 指向新目录并启动服务，通过 health check、登录、会话数量和抽样 transcript 验收。跨机器迁移使用相同步骤；备份含明文私人会话，离开本机前必须再用 age、git-crypt 或等价方式加密。密码哈希和 session secret 位于独立的 EnvironmentFile，不包含在数据备份中，应通过单独加密渠道迁移；若不迁移 session secret，所有旧登录 cookie 会自然失效。

## 隔离集成测试

以下命令会调用模型，但只允许使用无渠道绑定的 `paneltest` runtime，并会清理临时 session artifacts：

```sh
npm run test:paneltest
npm run test:app-paneltest
```

第二条覆盖：登录、真实 agent 只读摘要、新建 panel 会话、经 `paneltest` 生成、持久化读取、搜索和 fork。测试使用临时 `PANEL_DATA_DIR`，不会向真实活会话发送消息。
