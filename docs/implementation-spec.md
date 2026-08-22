# ark-panel 实现规格

本文是当前实现与验收契约，不是开发计划。产品范围见根目录 README，分层与数据流见
[`architecture.md`](architecture.md)，绑定设计取舍见 [`decisions/`](decisions/)。
历史施工记录只存在于 Git 历史和非规范 [`archive/`](archive/)；日期化验收文档只证明
对应运行时刻和环境。

## 0. 不变量

以下要求优先于功能便利性：

1. panel transcript、metadata、附件、run 和记忆工作流状态是面板权威数据；派生索引
   必须可清空重建。
2. 配置的 OpenClaw active/reset transcript 是只读来源。面板不能写入、重命名或删除
   这些源文件；对应用户 metadata 只写 panel sidecar。
3. 面板与 OpenClaw 不能共同写同一权威文件。生成必须保留“一次性 runtime session
   物化 → 完整结果验证 → panel 原子提交”的边界。
4. 完整 run、可变 metadata、候选和 settings 使用已有原子写与 durability helper；
   多行 append 不能被当作事务。
5. 拒绝 traversal、symlink、需要时的 hardlink、特殊文件和 allowlist 根外路径。浏览器
   永远不能选择主机路径。
6. 登录、固定 Host/Origin、CSRF、请求大小与同源资源边界不能因新增 HTTP 能力放松。
7. SSE 与 Gateway streaming 只是临时观察；经过完整校验并原子提交的 transcript 才能
   决定 completion 和下一轮上下文。
8. API 保持 `{ data }` / `{ error: { code, message, requestId } }` envelope 与稳定错误码。
   有规范化 DTO 时不能暴露上游原始 payload。
9. OpenClaw 适配固定为 `2026.6.11`；修改 RPC、scope、transcript、cleanup 或 runtime
   假设前，必须先完成隔离验收并更新工程决定。
10. 存储格式变化必须有显式迁移和回滚，不能静默重新解释既有权威数据。

## 1. 运行时、配置与部署入口

- Node.js `>=22 <23`，ESM，严格 TypeScript；包管理器为 npm。
- 服务端使用 Node 内置 HTTP，不使用 Web 框架。
- 浏览器 UI 使用原生 HTML、CSS、JavaScript；不引入前端框架。
- API 前缀为 `/api/v1`，静态资源与 KaTeX 均由面板同源提供。
- 进程只监听 `127.0.0.1`；`PANEL_PORT` 只改变端口，不改变监听主机。
- `PANEL_DATA_DIR` 是权威数据根。read agent、聊天 runtime、记忆 runtime 和 workspace
  只从服务端配置 allowlist 得到。

配置解析必须在启动时失败关闭。数据根与 OpenClaw source/runtime 根不得相同或父子
重叠；runtime 不能复用真实、渠道绑定的 agent。所有秘密只来自受保护的服务端环境或
经过 Gateway resolver 选择的配置，不能进入仓库、浏览器、错误或日志。

### 1.1 浏览器 origin 与 Host

默认只信任当前监听端口上的 `127.0.0.1` 和 `localhost` HTTP origin/Host。
HTTPS 反向代理部署使用：

- `PANEL_PUBLIC_ORIGIN`：唯一浏览器可见的精确 `http(s)://host[:port]`；
- `PANEL_SECURE_COOKIE=1`：HTTPS origin 的强制配套项；
- `PANEL_TRUSTED_HOSTS`：代理明确改写 Host 时才使用的有限精确 JSON 数组。

origin/Host 共用规范化规则。拒绝 wildcard、userinfo、路径、query、fragment、
IDN/punycode、替代数字 IP、非规范 IPv6 和规范化后的重复项。所有请求先校验实际
`Host`；登录与 mutation 还要求显式匹配的 `Origin`，mutation 再要求登录态和 CSRF。
缺失或 `null` Origin 不受信。应用不读取 `Forwarded`、`X-Forwarded-Host`、
`X-Forwarded-Proto` 或其它代理头，也不从请求学习信任。

失败保持既有 `HOST_REJECTED`、`ORIGIN_REJECTED` 和 `CSRF_REJECTED` 语义。配置错误
只指出变量/类别，不回显部署 hostname、请求头或路径。真实代理、TLS、登录、mutation
与长 SSE 当前部署状态必须由 #48 复验，不能由 fixture 测试推断为已通过。

## 2. 会话来源与权威存储

### 2.1 三类来源

| `sourceKind` | 来源 | 写入规则 |
| --- | --- | --- |
| `active` | 配置 agent sessions 根中的现行 active JSONL | 只读，变化后重新读取 |
| `reset` | 同一根中的现行 `.reset.` JSONL | 只读，不建立冻结导入副本 |
| `panel` | `PANEL_DATA_DIR/sessions/...` | 面板独占写入 |

active/reset 扫描只支持固定 OpenClaw 版本的现行命名与 v3 transcript 结构。读取正在
追加的 active 文件时只解析完整 JSONL 行，末尾半行留给下一次刷新。reset 也持续以
OpenClaw 源文件为准；sidecar 只保存面板用户意图，不复制正文成为第二份权威数据。

### 2.2 panel record

一条 panel 记录位于：

```text
PANEL_DATA_DIR/
  sessions/<agentId>/<recordId>/
    metadata.json
    transcript.jsonl
    attachments.json   # optional
```

`metadata.json` 至少承载稳定 `recordId`、agent、标题、fork 来源、归档/隐藏/置顶/project、
记忆处置与会话 override。`transcript.jsonl` 保留 v3 header、`id` / `parentId` 分支、
message、tool、thinking、model/thinking change、compaction 和未知但安全的既有 entry。

创建、新建 fork 和编辑重发使用同一发布事务：

1. 在目标 agent 目录的保留 staging 名称空间写完整记录；
2. 每个 `0600` 文件写完并 `fsync`；
3. `fsync` staging 目录；
4. 以一次目录 rename 发布为 `<recordId>/`；
5. `fsync` agent 父目录。

父目录首次创建也要逐层完成 durability。发布前记录不可枚举。失败后的 staging 作为
故障证据保留并隔离，不能自动删除；若 rename 后的 durability 无法确认，必须明确报
不确定，不能宣称成功。

### 2.3 fork 与编辑重发

fork 从目标 entry 沿 `parentId` 回溯完整祖先链；编辑重发回溯到被编辑 user entry 的
父节点，再添加替换后的 user entry。不能复制 JSONL 物理前缀，因为物理顺序可能包含
旁支。工具调用/结果与其它必须成组的 entry 不能被截成半组。祖先 message ID 可在新
transcript 内保留，但跨会话引用必须带 `recordId`。

任何来源都可以 fork，目标永远是新的 `panel` 记录。来源 transcript、metadata、附件
索引和 blob 不修改。

### 2.4 readonly sidecar

active/reset 的 `title`、`archived`、`hidden`、`memoryDisposition` 等写入
`PANEL_DATA_DIR/readonly-meta/<agentId>/`。文件名由稳定 source identity 摘要得到，
内容包含版本与组成字段并在读取时反校验；写入使用 per-identity mutex 和原子替换。

`archived` 与 `hidden` 正交：前者把记录放入归档视图，后者从普通和归档视图都隐藏。
只读来源的“删除”只能设置 `hidden`。panel 来源只有已归档并经过显式确认后才可删除
面板拥有的记录。

## 3. 单一会话读取索引

生产进程只构造一个进程内读取索引，覆盖 read-agent 与 attachment-runtime allowlist
的并集；各 consumer 在请求时再用自己的 allowlist 限定 snapshot/locator，不能因共享
缓存扩大授权范围。

索引主键是 `agentId + sourceKind + stable source identity`，二级 locator 是
`recordId -> ordered candidate keys`。跨 agent/source 的异常 `recordId` 碰撞必须在
列表和搜索中保留所有记录；只接受 recordId 的读取、mutation 或附件 owner 查询遇到
多候选时沿用 not-found 语义失败关闭，不能按刷新完成顺序选择 winner。

一次列表或搜索请求先取得一致 snapshot；新增/变化的记录至多解析一次。唯一定位的
单条读取只探测目标 source root。附件下载/预览只枚举索引中的 panel-source snapshot，
不能为附件 owner 检查去探测 external transcript root。

目录清单与安全 stat 身份只决定缓存是否失效；权威 document 和 metadata 仍逐条验证。
坏记录按自身指纹隔离。clear、定点失效和删除通过 epoch/generation 使旧扫描作废；
并发冷启动共享同一次重建。create/update/fork 的权威提交先于索引刷新，刷新失败只
标脏并在后续重建，API 返回已提交结果。

会话搜索只在用户已选择的 agent 内执行，覆盖当前普通或归档视图；当前没有单独的
source-kind 筛选控件或跨 agent 搜索。文档和 UI 不得声称存在这两项能力。

## 4. 附件、预览与产出文件

上传只接受字节和显示元数据；服务端签发附件 ID，并将 blob 以 SHA-256 内容寻址保存
到私有存储。manifest、owner 与 transcript attachment block 分离。单轮发送使用附件
ID；服务端重新校验 owner、普通文件、链接数、大小和 MIME/实际内容边界。

图片草稿使用浏览器本地 Blob URL。已提交附件预览只允许服务端完整解码、像素/尺寸
受限的单帧 PNG、JPEG、WebP，并返回 `nosniff`、`no-store` 与隔离 CSP。SVG、HTML、
动图、伪图片或部分解码失败都不内联。普通下载使用 attachment disposition。

生成永远收集当前 run 的上游 artifact。只有本轮 `requestOutputs: true` 时，服务端才
在配置的可信 workspace 下创建 `.openclaw/tmp/ark-panel/<run-id>/outputs` 并向本轮
runtime 消息增加产出说明。浏览器不能提交该路径，附件也不会自动开启这个开关。
artifact/outputs 必须在 runtime cleanup 前安全复制到 panel storage；任何路径、链接、
文件种类、竞态、文件数或总量违规都使本轮失败。

## 5. HTTP API 与同步

所有 API 都使用 JSON envelope；Markdown export、附件二进制和 SSE 是显式例外。
`GET /api/v1/health` 与 `POST /api/v1/auth/login` 无需已有登录态；两者仍受 Host 校验，
login 还要求允许的 Origin 并受频率限制。其余 `/api/v1` 路由要求登录。

当前 API 分组：

- authentication：login、session、logout；
- settings/avatar：账户设置与 agent 头像；
- sessions：agent、普通/归档列表、projects、revisions、agent 内搜索、conversation、
  create/update/delete、fork、edit-resend、Markdown export；
- attachments：upload、authenticated download/preview；
- runs：create、active lookup、snapshot、SSE subscribe、abort；
- commands：panel session structured command dispatch；
- memory：只读文件树/正文、会话状态、candidate、preview、confirm。

mutation 对 Content-Type、body 大小、字段 allowlist 和 runtime 类型做校验。conversation
DTO 只返回规范化 header/entry/status，不能回传 `cwd`、未知 header、内部 runtime ID 或
上游 payload。revision DTO 使用与读取索引相同的复合 identity，不能压缩回单值
recordId。

多设备正文同步使用 revision 轮询；run 观察使用持久 snapshot 与可重连 SSE。SSE 首帧
是 `run.snapshot`，此后用 `run.updated` 发送 sequence/stream revision 更新，终态发送
`run.completed`、`run.failed` 或 `run.aborted`；终态前 EOF 只表示连接丢失。浏览器只有
收到明确 completed 并重新读取权威 conversation 后才清草稿和预览。

## 6. run、幂等与生成编排

生成仅允许 `panel` 来源；active/reset 在任何 Gateway 调用前返回 `SOURCE_READ_ONLY`。
生产只有 `BridgeService.generate` 一个生成编排边界。`adapter.ts` 定义版本化协议和
类型，runtime/stream 探针只用于显式隔离验收，不是生产回落路径。

### 6.1 接受与指纹

HTTP 层在创建 run 前校验登录、panel source、请求字段/大小、附件 ID 数量和
idempotency key 格式。随后计算请求指纹，在创建门禁中检查重复 key 与既有 active run，
再原子持久化 accepted run。同一 record 同时只允许一个非终态 run。

后台执行取得该会话独占后重新加载权威记录，并在任何 Gateway 调用前校验 `/` 前缀、
expected revision、附件所有权/字节与上下文预算。这些检查失败时把 accepted run 推进为
durable failed，不写 transcript；accepted 表示服务端已接管任务，不等于上游已开始。

当前规范指纹用固定编码的 `recordId`、message、`expectedRevision`（缺失为 `null`）、
有序 attachment IDs，以及只在为真时出现的 `requestOutputs` 计算 SHA-256。JSON 属性
顺序与显式 `undefined` 不影响身份；附件顺序、revision、消息或产出意图变化都冲突。
附件功能前的旧 durable run 只在重试仍无附件且不请求产出时兼容旧 hash；新 run 不写
旧形状，也不重写历史权威记录。

相同 idempotency key + 相同指纹返回同一 active/terminal run；相同 key + 不同指纹
返回稳定冲突。终态清除暂存请求正文，但保留指纹。

### 6.2 一次性 runtime 流程

1. 通过版本化 Gateway RPC 创建一次性 session。
2. 将面板当前有效历史物化到其 transcript；尚未交给 `sessions.send` 的本轮 user 消息
   不能提前出现在文件中。
3. 应用当前 model/thinking/reasoning override，并调用 `sessions.send`。
4. trajectory watcher 与控制事件分别观察终态和临时预览；预览故障不能决定 completion。
   临时预览按合法 upstream sequence 形成有序 text/tool timeline。连续文本合并，同一 tool
   的完成/失败更新原始卡片且不移动；精确重复不增加 stream revision，乱序/重连重放收敛
   到同一结果，相同 sequence 的冲突事件失败关闭。无效或缺失 sequence 不得静默归零。
5. 完成后从 runtime transcript 读取新增 entry，核验新增 user entry 与请求一致并跳过，
   再验证完整 assistant/tool/custom 组。
6. 新 entries 先写入可恢复 run record；随后以临时文件、`fsync`、rename 原子提交完整
   panel transcript。
7. transcript 提交后写 completed snapshot；再执行官方注销和受限清理。

一次 run 的提交单位是完整 entry 组，不是最后一条 assistant 文本。streaming 期间不向
权威 transcript append。失败/abort 清除临时预览，不写部分 run；重试从未改变的权威
tip 重新开始。

timeline 是兼容字段 `text` / `tools` 之上的公开有序投影。正常 delta 只保留线性增量；晚
订阅时保留首个累计快照缺失的前缀。非前缀累计快照与 `replace=true` 不能伪造交错边界，
而是降级为一个明确的文本项，同时保留已观察到的工具锚点。前端文本继续走统一安全
Markdown renderer，tool 参数和固定 OpenClaw `2026.6.11` 的终态 `result` 只用文本节点。
终态 result 保留 JSON 结构但限制为 64 KiB，超限或不可序列化时输出固定省略标记；它只
属于临时预览，不能替代完成后读取并验证的权威 transcript。partial result 与 reasoning
不透传。

### 6.3 重启与 active-run 索引

run JSON 是权威状态。进程首次需要时扫描 run 根并构建单一 active-run 派生索引，之后
创建占用检查、active 查询和附件维护不扫描全部历史终态 run。accepted 只有在文件原子
落盘且目录 durability 完成后进入索引；终态只有持久化成功后移除。run 原子写一旦返回
失败，因 rename 可能已发生必须作废索引，并从磁盘重建当前可见状态。

在途旧扫描通过 generation 门禁作废，不能覆盖新写入。索引丢失、进程重启或缓存损坏
均从 run 文件恢复，不定义第二份持久格式。

重启恢复使用持久 `plannedUserEntryId` 和 staged entries 判断：已提交但未标终态的 run
补写 completed；可证明未开始且恢复 payload 完整的 accepted run 可重新调度；已有
完整 staged entries 的 run 按基线 revision 精确补提交；其它可能已产生工具副作用的
上游 run 标记 `RUN_ORPHANED_AFTER_RESTART`，不盲目重发。

### 6.4 停止、超时与保留

浏览器取消 fetch 与服务端 abort 是不同操作。只有服务端确认 aborting/aborted 才显示
已停止。timeout 后继续等待配置的 watcher grace，以区分上游 timeout、abort、普通
failure、未观察到 start 和 watcher timeout。清理前必须确认 terminal 且 no-active-run；
无法确认时保留 artifact 与 `cleanupPending`。

完整终态 run 默认保留 30 天，`PANEL_RUN_RETENTION_DAYS` 接受 `0` 到 `36500` 的整数，
其中 `0` 禁止后续退休。服务在启动恢复完成后执行首批维护，之后每 6 小时以不可重入
任务串行执行 run retirement 与附件维护。到期判定使用终态 `finishedAt`；非终态、缺少
合法时间或仍有 `cleanupPending` 的记录不能退休。

退休先把最小幂等信息写入按 runId hash 分配的 256 个固定、版本化 tombstone 分片之一，
确认原子替换及目录 durability 后，才按已固定的文件身份删除独立完整 run 文件。每个
run 的 put/create 与退休共享串行化边界；延迟 put 不能覆盖 tombstone。若进程在分片落盘
后、完整文件删除前退出，重启只在两者身份与指纹完全一致时清理重复副本；任何冲突均
失败关闭。维护按扫描数、退休数和耗时分批，不允许两个批次重叠。

256 个分片只为 tombstone inode 数提供固定上限；永久幂等所需的总字节仍随 run 数线性
增长。每个分片最多 16384 条且不超过 8 MiB，全部分片合计不超过 2 GiB；任一安全容量
上限将被突破时，本批退休必须失败关闭：保留完整 run，不删除或截断任何已有 tombstone。
继续扩容需要新的版本化格式、迁移与容量规划，不能静默提高边界。离线备份工具当前
上限为 20000 个条目、单文件 256 MiB、合计 4 GiB，
运维必须在接近边界前规划下一格式，而不能把备份成功当成无限容量保证。

tombstone 无限期保留 run/record identity、请求指纹及 matcher version、脱敏终态、sequence、
revision 与必要时间；不得保留消息、模型输出、附件、诊断正文、runtime/session 路径或
原始错误文本。相同 idempotency key 与相同指纹返回原终态且不执行，指纹不同仍返回
`IDEMPOTENCY_KEY_REUSED`。设为 `0` 不会把 tombstone 还原为完整记录。删除首个已转换的
完整 run 前必须已经完成并验证离线 pre-GC 备份。第一次以非零保留期启用时，若 durable
migration barrier 尚不存在，必须精确声明
`PANEL_RUN_RETENTION_MIGRATION_CONFIRM=verified-offline-pre-gc-backup-v1`；缺失时退休失败
关闭，声明空值或其它值则配置启动失败且不得回显该值。确认后原子写入 barrier，后续
启动不再需要该环境变量；保留期为 `0` 时不创建 barrier。旧 binary 的唯一回滚路径是
恢复该备份，禁止原地打开包含新分片格式的数据根。

## 7. Gateway WebSocket 契约

当前只支持 OpenClaw `2026.6.11`。服务端复用一条 control WebSocket，浏览器不能看到
Gateway URL 或 secret。

握手固定为：

- `client.id = gateway-client`；
- `client.mode = backend`；
- `role = operator`；
- requested scopes 恰好为 `operator.read`、`operator.write`、`operator.admin`；
- `hello-ok` 的版本、角色和 scopes 必须逐项精确相同。

缺少、额外、未知或重复 scope 使用 `GATEWAY_SCOPE_CONTRACT_VIOLATION`；版本不符使用
`OPENCLAW_VERSION_UNSUPPORTED`。握手和请求拒绝归一为稳定脱敏错误。不能利用 admin
蕴含关系接受缩写 grant。

版本化 RPC allowlist：

| scope | 方法 |
| --- | --- |
| read | `status`、`commands.list`、`tools.catalog`、`tools.effective`、`sessions.list`、`sessions.subscribe`、`sessions.messages.subscribe`、`sessions.messages.unsubscribe`、`artifacts.list`、`artifacts.download` |
| write | `sessions.create`、`sessions.send`、`sessions.abort` |
| admin | `sessions.patch`、`sessions.compact`、`sessions.delete` |

未登记方法在创建 socket/发帧前以 `GATEWAY_RPC_METHOD_NOT_ALLOWED` 拒绝。每条 socket
分配独立 source/generation；open、challenge、hello、message、error、close 和 send
callback 处理前必须确认仍是当前 generation。业务事件只有精确 hello 与订阅完成后才
投递。send throw/callback error/非 OPEN 状态会注销当前授权、拒绝 pending、关闭并
重新握手；旧 callback 不能注销新连接。

### 7.1 resolver 与 credential provenance

resolver 只解析一份严格 JSON OpenClaw 配置。selector 顺序、profile fail-closed、目录
候选及默认/legacy 文件名以
[`engineering-decisions.md`](decisions/engineering-decisions.md) 为绑定契约。找到但不可读
或无效的文件不向低优先级回落；空白显式 selector 失败。JSON5、`$include` 和未转义
`${VAR}` 不做部分解释。

本机 endpoint scheme 来自 `gateway.tls.enabled`；port 为合法、非空
`OPENCLAW_GATEWAY_PORT`，否则合法 `gateway.port`，否则 `18789`。已声明但空白/非法
的环境值不回落。origin 使用 scheme、规范 port 与带类型 host identity；loopback alias
可等价，普通 DNS hostname（包括字面 `loopback`）不能与 sentinel 混同。

公网 endpoint 必须 `wss://`；`ws://` 只允许固定版本认可的 loopback、private、
link-local、CGNAT、ULA、`.local` 和 `.ts.net`。TLS 证书验证不能关闭。

- 本机 `gateway.auth.mode=none` 始终禁用管理连接；panel 环境 secret 不能绕过。
- token/password mode 只选择同名 credential；mode 缺失仅在恰有一种 credential 时
  推导。
- trusted-proxy 只允许满足完整 userHeader/trustedProxies/mutex 条件的本机 password
  fallback；配置或 panel token presence 均使它拒绝。
- SecretRef 字符串/对象参与 presence、mode、歧义和互斥，但面板不执行 env/file/exec
  provider；选中的 ref 需要对应非空 `PANEL_*` 明文覆盖。
- remote mode 不回落本机默认，不继承本机 auth。配置 remote 要求安全 URL、显式
  `transport: direct`、无 `tlsFingerprint`；panel override 不能改变其 provenance。
- panel URL 改变带类型 origin，或在缺少配置 remote URL 时独立提供 endpoint，必须
  同时带自包含非空 panel credential group，且不继承磁盘 secret/transport/pin。

这组配置只能声明面板将发送的 endpoint/credential，不能证明目标 Gateway 实际强制
相同 secret。真实 server auth、scope grant、bootstrap、工具、memory 与 cleanup 必须在
#48 指定的无渠道 runtime 上复验；当前状态为 unknown。

`PANEL_OPENCLAW_STREAMING=0` 只关闭临时 text/tool preview；同一 control socket 与全部
三个 scope 仍用于 generation、commands、attachments 和 lifecycle。配置/连接失败保留
本地只读访问，需要 Gateway 的操作返回 `GATEWAY_TRANSPORT_UNAVAILABLE`；生产不回落
逐请求 CLI。

## 8. 结构化命令

普通 message API 永久拒绝 `/` 前缀；任务即使已被持久 run 层接管，也会在执行前以
`SLASH_COMMANDS_UNSUPPORTED` 进入 failed，不能调用 Gateway，也不能写 transcript。
命令 API 接受结构化 `{ command, args }`，用静态、版本化、default-deny allowlist
分派，绝不把命令文本送进 `sessions.send`。

| 分类 | 当前命令 | 语义 |
| --- | --- | --- |
| panel native | `/model`、`/think`、`/reasoning`、`/new` | metadata/新 panel 会话；override 下一轮生效 |
| compaction | `/compact` | typed `sessions.compact`，验证后持久化 compaction |
| read-only | `/commands`、`/help`、`/status`、`/models`、`/tools`、`/usage` | 规范化只读 DTO |
| unsupported | `/reset`、`/bash`、config/restart、未知/动态命令 | 无入口，服务端稳定拒绝 |

`commands.list` 只用于补全和说明，动态 skill/plugin 命令不会自动进入 allowlist。
`/tools` 返回配置层 runtime 工具目录，不代表当前 session 的动态授权或某次 run 一定可
调用。`/usage` 沿当前权威分支聚合 assistant entry 的模型上报 usage，缺失字段保持
coverage/unknown；它不是 Gateway 全局账单，也不做 tokenizer 估算。

`/model`、`/think`、`/reasoning` 无参数时返回当前值及各自目录；单个合法参数写入
override，`default` 清除。模型只接受唯一且 available 的规范 key/alias，thinking 必须
同时通过固定 level 与当前模型能力校验，reasoning 只接受 `on` / `off` / `stream`。
设置写 panel metadata 和可见系统事件，与进行中的 run 串行，并从下一轮生效。
`/new [title]` 在同一 agent 下创建新的 panel 会话。只读信息命令和 `/compact`
不接受额外参数。

命令 API 同样要求 panel 来源、登录、Origin 与 CSRF。只读信息命令不写 transcript；
设置命令不依赖一次性 runtime session 存续。完整分类依据见
[`slash-commands.md`](decisions/slash-commands.md)。

## 9. 上下文与持久压缩

发送前，`ConservativeContextBudget` 按 OpenClaw `2026.6.11` current-branch/compaction
语义投影面板将物化的历史，再加入本轮输入。当前方法为
`utf8-bytes-upper-bound-v3`，以 UTF-8 字节和固定结构开销作为保守上界，不是模型
tokenizer。默认历史预算为 100000，可配置但必须为系统提示、记忆、工具 schema 和输出
保留余量。

超限返回 `CONTEXT_BUDGET_EXCEEDED`，不创建 Gateway session、不写本轮 user entry。
用户可通过 `/compact`、会话动作或状态动作调用同一 structured compaction API；没有
自动压缩。

压缩只允许 panel 会话，并与 generation 使用同一会话独占边界和 revision CAS。服务端
物化当前分支、应用 override、调用 typed `sessions.compact`，随后重新读取原 runtime
transcript。仅当历史前缀未改、恰有一个结构/父链/边界合法的新 compaction，且同一预算
器证明候选有效上下文严格减少时才原子提交。否则返回
`NO_EFFECTIVE_REDUCTION`，权威 transcript/revision 不变；面板不能自行移动上游
`firstKeptEntryId` 来丢消息。

完整旧消息始终保留、可显示和导出；最新摘要、inclusive kept tail 与压缩后消息决定
下一轮有效上下文。fork 在压缩边界前不继承摘要，在边界及之后继承合法摘要。界面
token 状态只显示与当前 tip 绑定且 OpenClaw 标为 fresh 的 usage；否则明确 unknown，
不能用保守预算估算冒充实际用量。

## 10. 记忆合同

`memoryDisposition` 只有 `scratch` / `eligible`，默认 `scratch`。普通聊天的配置合同
要求两种状态使用同一目标 workspace、bootstrap 与工具策略；实现不能因 disposition
主动删减记忆能力。共享配置不证明具体 runtime 实际获得 bootstrap、memory tool 或召回
结果；这些逐 runtime 状态在 #48 前为 unknown。disposition 只授权面板管理的新内容沉淀：

- `scratch`：候选、确认与未来自动整理 API 由服务端拒绝；
- `eligible`：API 允许整份滚动候选与确认事务；真实模型执行仍待 #48；
- fork/编辑重发目标重新默认 `scratch`，不继承来源授权；
- 改回 `scratch`、归档/隐藏/删除来源都不级联删除已确认记忆。

只读记忆中心仅从服务端 workspace allowlist 读取 `MEMORY.md`、`DREAMS.md` 与
`memory/**/*.md`；接口接受 agentId 和服务端标识，不接受主机路径。读取拒绝越界、链接、
特殊文件和大小超限，正文不进日志。

候选使用独立一次性内部 session，沿用来源有效 model/thinking/reasoning。每个 session
创建后，面板查询其 `tools.effective` 清单，仅在没有工具或只有 `memory_search` /
`memory_get` 时继续；其它工具一律失败关闭。这个门禁是实现合同，不代表已有 runtime
完成真实验收；安全模型执行与实际工具状态在 #48 前为 unknown。普通聊天轨迹不受这项
候选门禁约束，候选轨迹也绝不写回来源 transcript。候选固定来源 revision/entry 范围、
checkpoint、state fingerprint 与内容 hash。预览只写 `PANEL_DATA_DIR`；确认 CAS 成功后
才原子创建/替换该会话唯一滚动文件，再写 ledger/checkpoint，并请求刷新真实 agent、
聊天 runtime、记忆 runtime 三份派生索引；真实刷新结果仍须逐环境验收。

滚动文件缺失不等于遗忘。用户可从最后确认的完整快照恢复并保留 checkpoint，或从完整
权威分支重建；浏览器不能提交恢复路径、正文、hash 或范围。详细原子顺序、幂等、旧
batch 兼容和回滚见 [`panel-memory.md`](decisions/panel-memory.md)。

确定性测试证明面板工作流边界；真实 bootstrap、memory tool、索引刷新与 runtime 隔离
在当前部署中的状态必须由 #48 复验，不能由旧日期证据推断。

## 11. 前端渲染与体验合同

中英文 locale catalog 的 key 和占位符必须一致。服务端账户设置是主题、强调色、locale、
会话状态和头像的权威来源；设备本地状态只用于阅读字号、rail、草稿、project 折叠和
后台未读。localStorage 不可用时必须安全降级，不能影响权威发送。

不受信内容只使用 text nodes 或既有安全 Markdown/KaTeX helper，不能新增用户控制的
`innerHTML`。raw HTML inert，危险 link scheme 不可点击。KaTeX、语法高亮与字体均
同源加载；解析失败显示原始文本，不能中断后续消息。

### 11.1 Markdown 图片隐私

最终消息、stream preview、memory viewer 与 memory candidate 复用同一图片策略：

- 外部绝对 HTTP(S) 图片默认只显示 alt 和规范化 origin，不创建 `<img>`、`fetch` 或
  server proxy/cache 请求；
- 仅 hostname 与 panel 不同的目标提供文字明确的新标签导航，固定
  `noopener noreferrer` 和 `referrerPolicy=no-referrer`；
- panel 同 hostname、异 scheme/port 的 origin 不提供导航，因为 host-only cookie 不按
  端口隔离；
- 只有精确同源、无 query/fragment 且匹配 `/api/v1/files/<id>/preview` 的既有认证附件
  可以内联；其它同源 URL、相对路径和 `file:` / `data:` / `blob:` / `javascript:` 均
  不可操作；
- 页面 CSP 保持 `img-src 'self' blob:`，不能为 Markdown 开放全局 HTTP(S) image。

真实 Firefox 验收需要两个独立本地 origin：默认渲染网络计数为零；显式跨 hostname
点击只产生一次目标请求且无 Referer/panel Cookie；同 hostname 异端口始终为零。

### 11.2 会话交互

草稿和单轮 `requestOutputs` 按 agent/session 隔离；发送失败保留，服务端接受 run 后才
清单轮开关，明确 completed 后才清草稿。只有所属会话因 active run 锁定，其它会话可
继续编辑。

长线程仅在用户接近底部时自动跟随；上翻时保留位置并显示新消息入口。后台 completed/
failed 按设备本地、每会话记录未读；用户 abort 不通知。桌面 rail 与移动端分层导航都
必须保留新建、搜索、最近会话、设置、记忆中心和 agent 切换的可访问入口。

## 12. 验证与当前限制

普通改动使用最窄相关测试迭代；跨层、存储、安全、lifecycle、依赖或发布改动最终运行：

```sh
npm run typecheck
npm run check:frontend
npm run build
npm test
```

coverage、fixture browser 与 deployment dry-run 只证明仓库内确定性边界。所有可能接触
真实 OpenClaw/runtime 的命令必须由任务明确把目标放入范围，并遵守对应验收文档；
不能因为命令存在就运行。

当前明确限制：

- 最小 run tombstone 为保持永久幂等而无限期保留；完整终态记录按配置的保留期退休；
- 只支持 OpenClaw `2026.6.11`；升级前必须重验软耦合面；
- active/reset 只读，不能从 panel 写回真实渠道会话；
- 搜索只在选定 agent 内，普通/归档由当前视图决定，无 source-kind 筛选；
- Markdown 外部图片不内联；只有显式跨 hostname 导航；
- runtime/bootstrap/memory/proxy/TLS/SSE 的当前真实部署状态在 #48 前为 unknown；
- memory candidate/rebuild 不复用普通聊天的保守上下文预算 preflight；它不得静默截断
  完整来源，但真实容量与失败行为须由 #48 验收；
- `/reset`、`/bash`、配置/重启、任意命令透传和自动压缩均不支持。
