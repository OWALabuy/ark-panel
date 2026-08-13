# ark-panel 架构

本文是当前架构契约。产品能力以根目录 README 为入口，接口与验收细节见
[`implementation-spec.md`](implementation-spec.md)，绑定取舍见
[`decisions/`](decisions/)。[`testing/`](testing/) 中的文档是各次验收的证据，
不等同于当前环境保证；[`archive/`](archive/) 仅保留历史背景，不具规范性。

ark-panel 是自托管、服务端权威的 OpenClaw 会话面板。服务端运行于 Node.js 22，
使用严格 TypeScript 和 Node 内置 HTTP；浏览器界面使用原生 HTML、CSS、JavaScript。
浏览器只访问面板的同源 HTTP API 与 SSE，不直接连接 Gateway，也不能选择主机路径。

## 1. 系统边界

```text
browser
  └─ same-origin HTTP + authenticated SSE
       └─ ark-panel (127.0.0.1)
            ├─ PANEL_DATA_DIR: panel transcripts, metadata, files, runs
            ├─ read-only scan: configured OpenClaw active/reset transcripts
            └─ one persistent control WebSocket
                 └─ version-gated OpenClaw Gateway
                      └─ one-use, channel-free runtime sessions
```

面板固定监听 `127.0.0.1`。远端浏览器通过 SSH 端口转发，或通过显式配置的单一
HTTPS 反向代理 origin 访问。反向代理只负责 TLS 和转发；它不改变应用监听地址，
也不是动态信任来源。

职责按依赖方向分层：

- `domain` 保存 transcript、fork、标识、上下文和导出等纯规则；
- `storage` 拥有文件系统扫描、权威面板存储、附件与原子写；
- `gateway` 隔离 OpenClaw 版本、协议、物化、流式观察与受限清理；
- `server` 负责配置、鉴权、HTTP/SSE、命令和生成生命周期编排；
- `frontend` 只消费规范化 DTO，并以安全 DOM 渲染。

浏览器样式继续作为同源静态资源直接加载，不引入构建链。`tokens-themes.css`
只定义基础 token、主题和强调色；`shell-navigation.css` 拥有桌面 shell、Agent、会话
导航、分组、未读状态与折叠 rail；`conversation-composer.css` 拥有会话头、消息、
流式预览、composer、命令、附件和图片预览的基础规则；`settings-memory.css`
拥有设置抽屉、记忆中心、记忆恢复及设置内头像操作的基础规则。四个语义层按上述
顺序先于 `styles.css` 的共享内容和兼容覆盖加载；`responsive.css` 最后加载，集中
管理断点、触控尺寸、安全区域和 visual viewport 覆盖。样式必须保持从 token 到
使用方、共享覆盖再到响应式覆盖的顺序，不能跨层重复定义同一组件的基础规则。

上游格式和 RPC 假设不能进入面板权威数据模型；浏览器 DTO 也不能暴露原始
Gateway payload、凭据或主机路径。

## 2. 权威数据与只读来源

| 数据 | 权威拥有者 | 面板行为 |
| --- | --- | --- |
| OpenClaw active transcript | OpenClaw | 按配置根扫描并只读；源变化后重新验证 |
| OpenClaw reset transcript | OpenClaw | 按现行 `.reset.` 格式只读；不是首次导入后冻结的副本 |
| active/reset 的标题、归档、隐藏、记忆处置 | ark-panel | 写入 `PANEL_DATA_DIR` 下的 sidecar，绝不回写源 transcript |
| panel 新建、fork、编辑重发与生成结果 | ark-panel | transcript 与 metadata 是权威数据 |
| 附件、产出文件、run 与记忆工作流状态 | ark-panel | 受限存储、原子更新并纳入离线备份 |
| 会话读取索引、active-run 索引 | 派生状态 | 仅在进程内，可清空并从权威文件重建 |

active 与 reset 来源始终只读。面板可以重命名、归档、恢复或隐藏其面板表示，
但不能写、改名或删除源文件。对这些来源继续对话必须先 fork 成 panel 会话。

panel 会话的可见记录位于
`sessions/<agentId>/<recordId>/`，包含 `metadata.json`、`transcript.jsonl` 和可选
`attachments.json`。新记录先在同一父目录的保留 staging 名称空间完成文件写入、
`fsync` 与附件引用校验，再以一次目录 rename 发布。发布前的半成品不会进入列表、
搜索、读取或附件回收；坏记录只隔离自身，并产生不含正文和私有绝对路径的诊断。

读取索引用 `agentId + sourceKind + stable source identity` 作为复合身份；
`recordId` 只是二级 locator。目录清单和安全 stat 指纹只决定缓存失效，document 与
metadata 每次仍来自权威文件。索引刷新失败不能把已经原子提交的权威写误报为失败；
索引会标脏并在后台或下次读取时重建。进程重启不依赖任何持久索引格式。

## 3. fork、附件与文件边界

fork 和编辑重发都创建新的 panel 会话，不修改来源。分支按 transcript 的
`id` / `parentId` 祖先链派生，而不是复制文件物理前缀；工具调用与结果等语义组不能
被截成半组。fork 只继承目标分支实际引用且归属一致、manifest/blob 完整的附件。

浏览器只上传字节、显示名与已签发的附件 ID，不能提交 `workspaceRoot`、输出目录或
其它主机路径。上传文件进入 `PANEL_DATA_DIR/files` 的内容寻址私有存储。历史图片在
物化时恢复为 OpenClaw 可消费的图片块；其它历史文件以受控说明保留，不把面板专用
attachment block 直接交给上游。

模型产出只来自当前 run 登记的 OpenClaw artifact，或服务端配置的可信 workspace 下
当前 run 的隔离输出目录。后者仅在该轮明确 `requestOutputs: true` 时启用。收集结果
先复制到面板存储，再清理临时目录；路径逃逸、链接、特殊文件、读取竞态、数量或大小
越界都使本轮失败。

## 4. 生成生命周期与流式预览

生成只允许 panel 会话。生产编排入口是 `BridgeService.generate`；Gateway adapter
负责固定版本协议，不另建第二套生产 run bridge。

1. HTTP 层先校验登录、panel 来源、请求形状和 idempotency key 格式；active/reset 在
   创建 run 前即拒绝。
2. 规范化请求字段生成同一 SHA-256 指纹。消息、revision、附件顺序或单轮产出意图
   变化都会冲突；对象属性顺序和显式 `undefined` 不改变身份。
3. 创建门禁检查重复 key 与既有 active run，再原子持久化 accepted run。后台执行取得
   会话独占后重读权威记录，并在任何 Gateway 调用前复核 revision、附件所有权/字节和
   上下文预算；失败写入终态 run，但不写 transcript。
4. Gateway 创建一次性、无渠道绑定的 runtime session；面板物化此前已完成的权威
   transcript，并通过 `sessions.send` 提交本轮消息。
5. 完成后读取并验证本轮完整 entry 组。entries 先进入可恢复 run 记录，再以原子
   文件替换提交 panel transcript。
6. 官方注销与受限 artifact 清理在结果安全接住后执行；无法证明运行已终止时保留
   `cleanupPending`，不能删除仍可能被上游写入的文件。

run 是持久的服务端资源，不从属于最初的 HTTP 请求。浏览器可查询、重新订阅 SSE、
停止或重试；同一会话最多有一个非终态 run。accepted、running、materializing、
committing、aborting 和终态转换只向前推进。服务重启从权威 run 文件重建 active
索引；无法证明可安全重放的上游 run 以孤儿失败结束，绝不盲目重发可能有工具副作用
的请求。

终态 run 目前无限期保留，以维持旧 idempotency key 的语义；终态记录会清除消息正文
与模型输出，只保留指纹、终态、revision 和必要诊断。这是当前限制。引入保留期之前
必须同时设计更长期 tombstone、迁移和回滚，不能直接 GC。

Gateway 的 `chat` 与 `agent` / `session.tool` 事件只形成进程内临时预览，通过面板 SSE 转发。
文本是上游汇聚后的快照，不承诺逐 token；工具 stdout 和 reasoning 不流式转发。
SSE 断开不表示 run 完成，预览丢失也不能决定终态。只有完成后重新读取、校验并原子
提交的完整 transcript 才是权威版本；失败或中止不持久化部分预览。

浏览器内的 run registry 只拥有按会话索引的内存快照和 v1 `localStorage` 持久化；
已确认 run 的查询、SSE 重试与同 runId watcher 去重由 DOM-free 的 run observer factory
协调；provisional creation 的查询后重试、同 runId 去重与 accepted handoff 由独立的
run creation reconciler factory 协调；存储扫描和会话 active-run 接管由 DOM-free 的 run
bootstrap factory 编排。三者的持久化、传输、终态处理、composer 所有权与界面反馈仍通过
`app.js` 显式回调注入。

## 5. Gateway 适配与权限

当前适配固定为 OpenClaw `2026.6.11`。面板复用一条服务端控制 WebSocket，身份为
`gateway-client/backend`、角色为 `operator`，请求并核验恰好以下 scope：

| scope | 允许的当前调用 |
| --- | --- |
| `operator.read` | `status`、`commands.list`、`tools.catalog`、`tools.effective`、`sessions.list`、session/message subscribe、`artifacts.list`、`artifacts.download` |
| `operator.write` | `sessions.create`、`sessions.send`、`sessions.abort` |
| `operator.admin` | `sessions.patch`、`sessions.compact`、`sessions.delete` |

`hello` 的版本、角色和 scope 集合必须精确匹配；缺少、重复或增加 scope 都失败关闭。
RPC 使用版本化 default-deny allowlist，未登记方法在发帧前拒绝。每个 socket generation
独立绑定来源、握手和订阅状态；旧 socket 的迟到事件或 callback 不能影响新连接。

配置、endpoint 与 credential provenance 是同一安全边界。resolver 只解析一份严格
JSON 配置，并按绑定的 selector 优先级选择；空白、歧义、部分 JSON5/include/env
解释、未知 transport、未支持的 fingerprint 或不安全明文公网 endpoint 均失败关闭。
本机 `auth.mode=none` 不建立管理连接。token/password 只能按已确认 mode 选择；
SecretRef 计入 presence 和互斥判断，但面板不执行 secret provider，选中的 ref 需要
对应的非空 panel 明文覆盖。remote 配置不继承本机 secret，也不回落到 localhost；
显式改变 origin 的 endpoint 必须带自包含凭据组。

这些 scope 是单一 trusted operator 部署中的纵深防线，不是多租户隔离。共享凭据是
owner 级 secret，只留在服务端。连接不可用时，本地只读浏览继续工作，需要 Gateway
的操作稳定返回 `GATEWAY_TRANSPORT_UNAVAILABLE`；生产不回落为逐请求 CLI 连接。
完整 resolver、轮换和回滚契约见
[`engineering-decisions.md`](decisions/engineering-decisions.md)。

真实部署是否实际强制相同凭据、bootstrap/工具/记忆注入是否仍符合固定版本假设，
当前均不能仅由确定性测试证明，必须在 #48 的受控 runtime 验收中重新确认。

## 6. 命令、上下文与记忆

普通消息 API 永久拒绝以 `/` 开头的输入。命令只走结构化 command API，并由静态、
版本化、default-deny allowlist 决定：

- panel 原生命令：`/model`、`/think`、`/reasoning`、`/new`；
- 持久压缩：`/compact` 调用 typed `sessions.compact`，验证并提交 compaction entry；
- 只读信息命令：`/commands`、`/help`、`/status`、`/models`、`/tools`、`/usage`；
- `/reset`、`/bash`、配置、重启和任意命令透传不受支持。

`/tools` 是配置层 runtime 工具目录，不保证某次 run 一定获准调用；`/usage` 只聚合
当前权威 transcript 分支中模型上报的 usage，不是账单或 tokenizer 估算。动态
`commands.list` 只用于展示和补全，不能自动扩大可执行范围。

发送前用固定版本的保守上下文投影检查预算。超限时不写本轮消息、不调用 Gateway。
压缩只接受上游新增且能让同一预算器严格减少有效上下文的合法 compaction；完整历史
仍保留并可导出；当前不自动压缩。

配置合同不因 `scratch` / `eligible` 改变普通聊天的 workspace、bootstrap 或工具策略；
处置状态只控制是否允许进入面板管理的候选、确认与写入流程。只有 `eligible` 获准进入
候选与滚动文件事务，用户确认前不修改 workspace。记忆中心只读服务端 allowlist 内的
`MEMORY.md`、`DREAMS.md` 和 `memory/**/*.md`。共享 workspace 只是一项配置要求，不能
证明某个 runtime 实际注入或召回记忆；逐 runtime 状态在 #48 前为 unknown。详细恢复、
索引刷新和工具边界见
[`panel-memory.md`](decisions/panel-memory.md)。

## 7. 浏览器与 HTTP 安全边界

面板登录使用慢密码哈希、HttpOnly/SameSite cookie、登录限速；mutation 同时要求
登录态、匹配的 Origin 与 CSRF token。实际 `Host` 在所有请求上校验。配置 HTTPS
反代时，`PANEL_PUBLIC_ORIGIN` 声明唯一浏览器 origin，`PANEL_TRUSTED_HOSTS` 只补充
代理明确改写的有限精确 Host。面板不读取 `Forwarded` 或 `X-Forwarded-*`，也不从
请求动态学习信任。

不受信 Markdown 使用安全 DOM，raw HTML 不执行。外部 HTTP(S) 图片默认零请求：
只显示 alt 与规范化 origin；仅跨 hostname 目标提供显式、无 Referer 的新标签导航。
同 hostname 异 origin 不可导航。只有精确同源、无 query/fragment 且匹配现有认证
附件 preview 路由的图片可以内联。CSP 的 `img-src` 仅允许 `'self' blob:`。

浏览器入口 `app.js` 负责 DOM、同源 API 与模块组装；composer 的草稿、单轮产出意图、
待发送附件和 submission ownership 由 DOM-free 的 `composer-state.js` factory 持有。
factory 只使用显式注入的 storage 与 Blob URL 能力，所有读写都要求显式 agent/session
scope；它不读取 window/global、locale、DOM 或 generation 状态。new-agent 自动建会话时，
opaque submission receipt 将 draft、产出意图、附件顺序和锁一起提升到新 session scope；
旧 receipt 不能结束后继 submission，公开 snapshot 也不能修改内部状态。若创建 session
后 storage scope 提升无法逐项写入并回读确认，composer 不会 POST run；内存 latch 保留唯一
created record，显式重试复用该 record 而不再创建 session。storage 补偿仅属 best effort，
残留值至多是已知的 draft/产出意图副本，永不被自动发送，不宣称跨 localStorage key 原子。

generation recovery policy 不导入 composer。`app.js` 只在服务端确认接管 run 后协调消费
该轮产出意图，并只在明确 completed 时请求 composer 清理；草稿已被继续编辑时不清理
任何状态，仍属于该 run 的已上传附件才会移除并精确释放本地 Blob URL。failed/aborted
不触发 composer terminal 清理。v1 localStorage key 保持原字节合同；普通草稿保存仍可
fail-soft，但 new-agent 到 session 的 ownership 提升对 storage 失败关闭，保留可见的源
composer 状态等待用户重试。

服务端日志、错误、fixture 和文档不得包含凭据、消息正文、prompt、原始上游 payload
或不必要的私有路径。文件读取、上传、预览、下载、备份和清理都拒绝 traversal、
symlink、需要时的 hardlink、特殊文件和 allowlist 根外路径。

## 8. 运维与验收状态

离线备份覆盖 `PANEL_DATA_DIR` 的权威数据，不包含 Gateway secret 或 runtime artifact。
恢复始终写入不存在的新目录，逐文件复核大小和 SHA-256 后再切换配置；重建派生索引
不需要迁移。存储格式若变化，必须同时给出迁移和回滚方案。

确定性单元、fixture 浏览器和部署 dry-run 证明仓库内契约；它们不证明某台真实
OpenClaw、反向代理或记忆 runtime 当前仍与假设一致。真实 runtime、bootstrap、
memory、proxy/TLS 与 SSE 部署矩阵的当前状态在 #48 完成前均为 unknown。任何 live
write 验收都只允许对明确指定、无渠道绑定的测试目标，并遵循对应验收文档。
