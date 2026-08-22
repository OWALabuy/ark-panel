# ark-panel 部署、备份与恢复

本地会话面板服务。Node.js 22，默认只监听 `127.0.0.1`。真实 OpenClaw agent 的 sessions 目录只作为只读数据源；所有新建、fork、编辑重发和后续推理结果只写入 `PANEL_DATA_DIR`。

面板自建 / fork 会话支持当前 panel-native、持久压缩和只读信息命令。普通消息接口
仍会在调用 Gateway 前拒绝以 `/` 开头的输入；命令必须走独立结构化派发接口。支持
范围和隔离原则见[斜杠命令决定](../decisions/slash-commands.md)。

当前产品范围见根目录 [`README.md`](../../README.md) 与
[`README.zh-CN.md`](../../README.zh-CN.md)。SSE 可重新订阅持久 run snapshot，并转发
临时文本/工具预览；完成后浏览器重新读取经校验、原子提交的完整 transcript。预览不
承诺逐 token，也不能决定 run completion。

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
export PANEL_USERNAME='panel-user'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='至少32字符的随机秘密'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
# HTTPS 反代时设置：
# export PANEL_PUBLIC_ORIGIN='https://panel.example.com'
# export PANEL_SECURE_COOKIE='1'
# 代理改写 Host 时才补充精确值：
# export PANEL_TRUSTED_HOSTS='["panel-internal.example.com"]'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'
export PANEL_RUN_RETENTION_DAYS='30'

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

`PANEL_READ_AGENTS` 是可浏览的真实 agent allowlist。`PANEL_AGENT_RUNTIMES` 把面板
会话所属 agent 映射到无渠道绑定的专用推理 agent；禁止把真实 agent 本身配置成
runtime。`workspaceRoot` 是服务端可信配置，用于创建本轮隔离的模型产出目录；不配置
时仍可上传附件，但不会启用该目录的产出收集。示例 ID 和路径都是占位符，部署时替换
为当前机器的专用目录；测试 runtime 只允许用于明确的隔离集成测试。

`PANEL_MEMORY_RUNTIMES` 可选。配置前先在 OpenClaw 中创建独立、无渠道绑定的
`panel-memory-*` agent，让它与对应普通 runtime 共享 workspace，并把工具限制为无工具
或仅 `memory_search` / `memory_get`。面板创建每个内部 session 后会核对其
`tools.effective` 清单；不能证明无副作用时拒绝提炼。首次启用必须按记忆模块决定在
指定隔离环境验收，不要直接以渠道绑定的真实 agent 做首验。当前真实 bootstrap、召回、
逐会话有效工具、模型执行和索引刷新状态在 #48 前未知。

附件 blob、manifest 和会话引用都在 `PANEL_DATA_DIR/files` / `PANEL_DATA_DIR/sessions` 下，因此现有离线备份会一并包含它们。workspace 中的 `.openclaw/tmp/ark-panel/<run-id>` 只是运行期暂存，不应单独备份；服务会在内容安全复制进面板存储后清理。

启动：

```sh
npm run build
npm start
```

启动时会执行配置安全检查并初始化数据目录：

- `PANEL_DATA_DIR` 自动创建并收紧为 `0700`；
- read、runtime、data 目录不得相同或存在父子重叠；
- runtime 路径必须与其 agent ID 对应，且不能是符号链接；
- 静态资源路径按程序安装位置解析，不依赖启动时的 cwd；部署时必须完整保留 `src/frontend/vendor/katex/` 下的 JS、CSS、许可证和 WOFF2 字体，不能只复制顶层 HTML/CSS/JS。KaTeX 资源由面板同源提供，不需要也不应改为 CDN。

健康检查无需登录：

```sh
npm run healthcheck
# 或 curl --fail http://127.0.0.1:8790/api/v1/health
```

## HTTPS 反向代理

面板进程在反代部署中仍只监听 `127.0.0.1`，不能把监听地址改成公网接口。
在 systemd 的 `panel.env` 中同时配置浏览器看到的唯一 origin 和安全 Cookie：

```sh
PANEL_PUBLIC_ORIGIN='https://panel.example.com'
PANEL_SECURE_COOKIE='1'
```

origin 只接受精确的 `http(s)://host[:port]`，不能有末尾 `/`、userinfo、路径、
query、fragment 或 wildcard。默认端口会规范化，Host 大小写会规范化；规范化后
的重复项会拒绝启动。为避免 IDNA、数字 IP 和 IPv6 的多种文本表示形成配置歧义，
IDN/punycode、替代数字 IP 写法和非规范 IPv6 写法也会拒绝。HTTPS origin 未同时
设置 `PANEL_SECURE_COOKIE=1` 时服务拒绝启动。

origin 对应的 Host 自动加入信任列表。若代理有意把公网 Host 改成另一个固定值，
可以用 `PANEL_TRUSTED_HOSTS` JSON 数组增加最多 16 个精确 Host；不要在其中重复
origin Host 或默认的 `127.0.0.1:<port>` / `localhost:<port>`。通常应保留公网
Host，而不需要设置这个变量。

完整 nginx 示例：

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

修改后先执行 `nginx -t`，再重启面板并 reload nginx。使用正式证书验证静态页、
登录、创建或修改操作，以及保持一段 SSE 连接；健康检查可访问
`https://panel.example.com/api/v1/health`。面板始终直接校验实际 `Host` 和浏览器
`Origin`，完全忽略 `Forwarded`、`X-Forwarded-Host`、`X-Forwarded-Proto` 等头，
因此配置这些头不会产生信任。登录和 mutation 的 Origin 缺失、为 `null` 或不匹配
时仍拒绝，mutation 还必须通过既有 CSRF token 校验。

回滚时移除 `PANEL_PUBLIC_ORIGIN` 与 `PANEL_TRUSTED_HOSTS`，按需恢复
`PANEL_SECURE_COOKIE`，重启面板后回到仅本机/SSH 转发的 HTTP 信任边界。该变化
不修改任何会话或配置存储 schema。

当前固定支持 OpenClaw `2026.6.11`，升级 OpenClaw 前必须按 support/acceptance matrix
重跑受控集成验收。

## 数据与并发语义

- `GET /api/v1/sessions` 返回每条记录的 `revision` 和 `updatedAt`。
- `GET /api/v1/revisions?agentId=...` 提供轻量轮询数据。
- 新建 panel 会话：`POST /api/v1/sessions`，请求体为 `{ "agentId": "assistant", "title": "可选标题" }`。
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

## 长上下文保护

面板在创建 gateway 临时 session 之前，对“完整历史 + 本轮用户消息”执行保守预算检查。默认历史预算为 `100000` tokens，可通过 `PANEL_CONTEXT_HISTORY_BUDGET_TOKENS` 调整（至少 1024）。

当前估算器是稳定、可测试的 `utf8-bytes-upper-bound-v3`：先按 OpenClaw 2026.6.11 的有效上下文语义投影 current branch；最新 compaction 之前只保留摘要与 inclusive kept tail，之后保留新消息，再以序列化投影的 UTF-8 字节数作为 token 数上界并增加固定结构开销。它不是模型官方 tokenizer，会明显高估普通文本；预算只覆盖面板提供的历史，默认值还为 gateway 额外注入的系统提示、记忆、工具定义和模型输出留出空间。

若估算超过预算，推理不会触达 gateway，panel transcript 也不会写入本轮 user entry。SSE 返回稳定错误码 `CONTEXT_BUDGET_EXCEEDED`、估算值和压缩操作。用户可从会话操作、90% 状态动作或 `/compact` 手动触发同一结构化压缩 API；面板不会自动压缩。eligible 会话若有 checkpoint 后新消息，可先进入现有候选预览确认，再自动继续压缩，也可直接压缩。

调整预算时应同时考虑所用模型上下文窗口、runtime 系统提示和工具集合大小。把值设得接近模型最大窗口并不安全。

## systemd 用户服务

仓库提供 [../../deploy/ark-panel.service](../../deploy/ark-panel.service) 示例。它固定使用 `127.0.0.1` 上的应用服务、从独立 `EnvironmentFile` 读取配置，并把真实会话目录声明为只读。

1. 复制示例到用户服务目录，替换其中的占位用户、仓库路径和专用 runtime 目录。
2. 建立权限为 `0600` 的专用 EnvironmentFile；该文件包含账号、密码哈希和 session secret，不能提交到 git。
3. 确保数据目录为 `0700`，runtime sessions 目录只属于当前用户；不要把真实 agent sessions 放进 `ReadWritePaths`。启用记忆整理时，OpenClaw 配置中的真实 agent、普通 runtime 和记忆 runtime 都必须已经建立各自的 `agent/` 数据库目录，并把这些目录加入 `ReadWritePaths`，以便确认后刷新派生记忆索引；这不允许写真实 agent 的 `sessions/`。
4. Node 若不在 systemd 默认 `PATH` 中，在 EnvironmentFile 设置受控的 `PATH`，或把 `ExecStart` 改成 Node 22 的绝对路径。
5. 启动并检查：

```sh
systemctl --user daemon-reload
systemctl --user enable --now ark-panel.service
systemctl --user status ark-panel.service
curl --fail http://127.0.0.1:8790/api/v1/health
```

服务示例启用了 `UMask=0077`、`NoNewPrivileges`、只读 home/system 防护和显式可写目录。记忆确认会写 workspace 下的短期文件，并调用 OpenClaw 更新各消费者自己的派生 `openclaw-agent.sqlite`，因此示例只放行对应的 `memory/`、panel runtime sessions 和 `agent/` 数据库目录。若实际 agent 名或数据路径不同，必须同步调整 `ReadOnlyPaths` / `ReadWritePaths`，否则服务应当启动失败，而不是放宽整个 home 的写权限。

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

备份工具只处理 `PANEL_DATA_DIR`，不会连接 Gateway，也显式拒绝 OpenClaw agent 根。
操作前应停止用户服务，以得到同一时点的一致快照。以下路径均为部署占位符：

```sh
systemctl --user stop ark-panel.service
cd /srv/ark-panel
npm run build
mkdir -m 700 -p /srv/backups/ark-panel
npm run backup -- backup "$PANEL_DATA_DIR" /srv/backups/ark-panel before-upgrade
npm run backup -- verify /srv/backups/ark-panel/before-upgrade
```

每份备份含逐文件大小/SHA-256 和空目录清单的 `manifest.json`。工具拒绝 symlink、特殊文件、路径越界、源/目标重叠、已有同名备份，以及超过 20000 个条目、单文件 256 MiB 或合计 4 GiB 的输入；先在备份根下完成权限为 `0700/0600` 的临时树并同步，再原子改名发布。恢复使用目标名锁避免并发操作，在实际复制时逐文件再次核对大小和哈希，并复核目标父目录身份；恢复目标仍必须不存在。

### 终态 run 保留与回滚

`PANEL_RUN_RETENTION_DAYS` 默认 `30`，接受 `0` 到 `36500` 的整数。完整终态 run 到期后，
维护任务把最小幂等 tombstone 无限期保留在 256 个固定分片中，再删除对应独立 run 文件。
服务启动恢复完成后执行首批维护，之后每 6 小时串行维护；批次不会重叠。设为 `0` 只会
停止后续退休，已经写入分片的 tombstone 不会恢复为完整记录。

固定 256 个分片只限制 inode 数；永久幂等条目的总字节仍会随历史 run 线性增长。分片或
总容量触及安全上限（每分片 16384 条或 8 MiB，全部分片合计 2 GiB）时，退休会失败
关闭，保留对应完整 run 且不会删除已有 tombstone。这时必须先评审新的版本化格式和
容量迁移方案。备份的 20000 条目、单文件 256 MiB、
总计 4 GiB 上限同样适用，接近任一边界前必须扩展容量规划。

从不含 tombstone 分片的版本升级时，必须在删除首个已转换的完整 run 前按上面的步骤
停止服务并完成、验证一份离线 pre-GC 备份；若暂未准备好回滚备份，先显式设置
`PANEL_RUN_RETENTION_DAYS=0`。
首次以非零保留期受控启动时，临时设置且只接受以下精确确认值：

```sh
PANEL_RUN_RETENTION_MIGRATION_CONFIRM='verified-offline-pre-gc-backup-v1' npm start
```

若 durable migration barrier 尚不存在，缺少确认时不会退休；声明空值或任何其它值会
拒绝启动且日志不回显该值。服务成功写入 barrier 后移除这个一次性环境变量，后续启动
不再需要它；保留期为 `0` 时不会创建 barrier。一旦 GC 已经写入分片，旧 binary 不能
安全打开该数据目录。回滚只能停止服务并恢复那份
启用 GC 前的备份到新的数据目录；不要删除分片、把天数改为 `0`，或手工拼接新旧 run 文件。

恢复永远写入一个不存在的新目录，校验全部文件后才原子就位，不覆盖现有数据：

```sh
npm run backup -- restore /srv/backups/ark-panel/before-upgrade /srv/ark-panel-data-restored
```

随后把 `PANEL_DATA_DIR` 指向新目录并启动服务，通过 health check、登录、会话数量和抽样 transcript 验收。跨机器迁移使用相同步骤；备份含明文私人会话，离开本机前必须再用 age、git-crypt 或等价方式加密。密码哈希和 session secret 位于独立的 EnvironmentFile，不包含在数据备份中，应通过单独加密渠道迁移；若不迁移 session secret，所有旧登录 cookie 会自然失效。

## 显式隔离集成验收

以下命令会调用模型并操作 OpenClaw runtime；不要把它们当作普通部署检查运行。只有当
任务已明确指定无渠道绑定的测试 agent、相关 workspace/session roots，并满足对应确认
条件时才可执行：

```sh
npm run test:paneltest
npm run test:app-paneltest
```

第二条覆盖登录、只读来源摘要、新建 panel 会话、测试 runtime 生成、持久化读取、搜索
和 fork。配置必须使用临时 `PANEL_DATA_DIR`，不能向 active/reset 或任何渠道绑定的 agent
发送消息。更多命令、前置条件和当前结论以 [`../testing/README.md`](../testing/README.md)
为准；日期化结果本身不是当前部署保证。当前真实 runtime、bootstrap、memory、proxy/
TLS 和 SSE 状态在 #48 完成前均为 unknown。
