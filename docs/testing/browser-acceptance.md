# 浏览器自动化验收

> **当前自动化与日期化证据元数据**
>
> - Date: `2026-08-12`（初始自动化）、`2026-08-13`（#13 会话列表菜单、
>   #43 网络边界复验、#49 composer 状态迁移 characterization、browser run 刷新恢复回归）、
>   `2026-08-14`（#27 有序流式预览、#19/#20 会话状态布局、上下文用量与设置持久化、
>   #43 当前网络边界复验）
> - ark-panel commit: `3a29ee4`（初始自动化）、`cfe53d9`（外部图片边界）、
>   `2e86ed8`（#49 characterization）、`8e1e197`（刷新恢复修复）、`c880390`（#13）、
>   `3db3d00`（#27）、`1f97c0c`（#19/#20）、`6574548`（#43 当前复验）
> - OpenClaw version: 不适用（虚构本地 browser fixture）
> - Status: runbook `current automated`；2026-08-12 result `historical pass`；
>   2026-08-13 #43 result `partial`；2026-08-13 #49 result `historical pass`；
>   browser run 刷新恢复 scope `current automated`；2026-08-13 #13 result
>   `historical pass`，对应 scope `current automated`；2026-08-14 #27 与 #19/#20
>   results `historical pass`，对应 scopes `current automated`；2026-08-14 #43 result
>   `historical pass`，对应 scope `current automated`
> - Superseded/current applicability: 本文件仍是 Firefox 自动化 runbook；其中每次
>   运行结果只适用于自己的日期与 commit。2026-08-13 的 #43 三轮结果因两次
>   `DRIVER_QUIT_FAILED` 记为 `partial`，详见
>   [current acceptance matrix](README.md)。更早的 2026-07-11 手工结果已独立
>   保存为[历史证据](browser-acceptance-2026-07-11.md)。

2026-08-12 起，仓库通过 `npm run test:browser` 执行真实 Firefox/WebDriver
交互验收。测试只使用 `test/browser-fixture.mjs` 中完全虚构的内存数据，监听
`127.0.0.1` 的临时端口，不读取 agent、workspace 或用户目录，也不连接
OpenClaw、Gateway、模型、IM 或其它外部服务。

## 运行

先安装 Node.js 22、Firefox 和 geckodriver，然后执行：

```sh
npm ci
npm run test:browser
```

驱动默认从系统 `PATH` 查找 Firefox 和 geckodriver。本地安装位置特殊时可分别
设置 `PANEL_FIREFOX_BINARY` 和 `PANEL_GECKODRIVER_BINARY`。依赖中的
`selenium-webdriver` 不下载浏览器；CI 使用 runner 已安装的 Firefox 和
geckodriver，并执行同一条 npm script。

2026-08-12 的初始浏览器自动化验收使用 Firefox 153.0.1 与 geckodriver 0.37.0 连续执行三次完整
suite，三次均为 2/2 通过；结束后未留下监听进程、浏览器进程、截图或 fixture
目录。这是初始浏览器自动化变更的日期化证据，不替代后续 CI 结果。

2026-08-13 的外部图片网络边界验收使用 Node.js 22.22.0、Firefox 153.0.1 与
geckodriver 0.37.0，有界执行三轮完整 suite。三轮的桌面与移动测试主体均完成，
其中一轮为 2/2 clean；另外两轮分别在移动、桌面主体完成后命中既有
`DRIVER_QUIT_FAILED` 清理抖动，不能记为连续三轮全绿。三次桌面主体均确认：
渲染前后跨主机与同主机异端口 probe 请求均为 0；点击唯一跨主机链接后仅对应
路径变为 1，请求不含 Referer 或 panel Cookie，新标签 `opener` 为空；同主机异
端口路径仍为 0。失败轮的 driver service fallback 与 fixture close 未报告失败，
验收结束后未留下该 fixture 拥有的 listener、geckodriver 或截图产物。这是 #43
的日期化证据，不把 stock teardown 抖动冒充功能成功或连续全绿，也不替代后续
CI 结果。

2026-08-14 在 canonical commit `6574548` 上重新串行执行三轮完整 suite，三轮均为
2/2 clean、exit 0。desktop 分别为 41.9、41.9、42.8 秒，coarse mobile 分别为
16.0、17.1、17.0 秒；每轮都重新经过上述外部图片零自动请求、唯一显式跨主机导航、
no-referrer/no-cookie/no-opener 与同主机异端口拒绝断言。该结果不改写 2026-08-13
的 partial 历史，也不证明 Chromium、WebKit、真实代理或 live runtime 行为。

2026-08-13 的 #49 composer 状态迁移 characterization 使用 Node.js 22.22.0、
Firefox 153.0.1 与 geckodriver 0.37.0，以 canonical commit `2e86ed8` 为证据快照有界执行三轮完整
suite，三轮均为 2/2 通过，未命中 stock teardown 抖动。桌面场景通过一次性事件
gate 确认：从 `new:<agent>` 自动创建会话时仅发起一次 session create，draft、
output intent、待发送附件与 submission scope 迁移到 `session:<record>`；run 被
accepted 前 output intent 保留，accepted 后才消费；另一会话在该 run 期间产生的
新 draft 与附件不被 terminal 清除；failed 与 aborted run 保留本会话 draft 和
附件，retry 不重复上传且复用同一 attachment ID。三轮结束后均未留下 fixture
附件目录、截图或 fixture 拥有的 listener。

同次探索还发现刷新恢复路径不能记为通过：基线会把 localStorage 中未保存
status 的 run 还原为 `accepted`，进而以相同 run ID 重放一次 create POST。服务端
幂等边界避免重复执行，但“只恢复 watcher、不重放 create 请求”仍需独立产品修复；
本 characterization 没有修改前端，也没有把该路径列入通过范围。

上述段落保留当时的基线发现；该问题现由下述刷新恢复修复关闭，不倒写为 #49
characterization 当时已通过。

同日新增的刷新恢复回归固定 `ark-panel:run:v1:<recordId>` key，不迁移或重解释
既有数据，只为持久值增加 `status` 与 `createPhase`。恢复总是先查询同一 `runId`；
合法且归属匹配的 200 snapshot 只 settle/watch，不发 create，畸形或归属不匹配的
200 snapshot 同样不会触发写请求。只有该查询精确返回 `404 RUN_NOT_FOUND` 后才查询
该会话 active run：同会话的相同或不同 active run 都只 watch，且不同 run 不继承
旧 submitted payload；跨会话或畸形 active snapshot 不触发 create。只有 active 精确为 null，
且本地记录是完整合法的 `provisional` 或无 `createPhase` 旧格式，才用原
idempotency key 补发一次 create。`acknowledged`、running、terminal、不完整和损坏
记录均不补发；网络、5xx、存储失败也不能被当作 404。初次 provisional 写失败不阻止
紧接着的原始 POST；若 POST 结果不确定且服务端仍无可观察 run，前端才放弃自动补发并
恢复 composer，由用户显式重试，避免永久卡住。POST 已获服务端响应但 acknowledged
写失败时，前端尽力移除旧 provisional key，继续以内存状态 watch，刷新后再从 active run
恢复，不把旧 provisional 当成补发依据。
同一 `runId` 若出现在多个 session key 下，预扫描会同时清除这些冲突记录，不启动
查询、watcher 或 create；客户端不能猜测其归属。

这不能消除 POST 已发出、但服务端尚无可观察 durable run 时进程恰好崩溃的极窄
歧义；该窗口仍依赖服务端对同 idempotency key 的持久幂等语义。测试只证明浏览器
按上述查询顺序恢复，不把客户端状态冒充服务端 durability。

刷新恢复修复以 canonical commit `8e1e197` 为证据快照，使用 Node.js 22.22.0、Firefox 153.0.1 与
geckodriver 0.37.0 有界执行三轮完整 suite，三轮均为 2/2 clean。每轮桌面场景都
确认：可观察 durable run 刷新后增加 GET 而 create 计数不变，随后 terminal 正常
替换预览；active-other 只 watch 服务端 run 且不继承旧 payload；仅确认缺失的
provisional 用原 key 补建一次并同步 `acknowledged`；损坏值发出零次 run GET/create。
无 `createPhase` 的完整旧格式补建矩阵，以及 acknowledged 写失败清除旧 key 的
fail-closed 转换由无 DOM focused regressions 覆盖；Firefox 的刷新用例覆盖其后续
active-run 恢复语义。
补建路径还断言统一请求轨迹严格为 `GET run → GET active → POST`，跨 session 的
重复 runId 同样发出零次恢复请求。
三轮的移动场景也全部通过，结束后没有 fixture 目录、截图或 fixture 拥有的 listener。
这是本修复的日期化 fixture 证据，不替代真实 runtime 或后续 CI 结果。

2026-08-13 的 browser teardown race 修复在提交前隔离 worktree 中，使用同一
Node.js、Firefox 与 geckodriver 版本，先将 cleanup、startup ownership、launcher
协议、service 与 Linux supervisor 的 33 项 focused tests 连续执行五轮，每轮
33/33 通过。移除 fake service 的无条件 10 秒退出后，又将 service、launcher 和
supervisor 的 15 项进程密集测试连续执行 20 轮，每轮 15/15 通过，结束后精确
geckodriver/launcher residual 均为 0。随后真实 Firefox 执行四份顺序 suite 与一批
两份并发 suite，共 12 个
desktop/mobile 场景全部通过；其中两次 desktop 的 WebDriver HTTP `quit` 超过 5 秒，
但各自已捕获的 owned tree 都在 TERM 阶段确定退出，因此按契约记为 clean。每批结束
后按 launcher/geckodriver 的精确进程身份与 session、`rust_mozprofile` 目录以及
fixture-owned listener 复核均无 owned residual。主机上另有不属于测试 session 的
既有 Firefox 实例，本证据不声称系统全局 Firefox 进程计数不变。

2026-08-13 的 #13 会话列表菜单修复以 canonical commit `c880390` 为证据快照，使用
Node.js 22.22.0、Firefox 153.0.1 与 geckodriver 0.37.0 有界执行三轮完整 suite；
两轮为 2/2 clean。两轮的 desktop 与 coarse-pointer mobile 场景都确认列表首端和
末端菜单保持在 visual viewport 内，同一时刻只有一个菜单打开，外部 pointer 关闭时
不把焦点拉回触发器，Escape 关闭并恢复对应 summary 焦点。desktop 另覆盖下缘向上
放置，以及菜单打开时 sessions scroll 和 viewport resize 触发重新定位。另一轮的
同一菜单矩阵和 mobile 场景完成后，desktop 在后续既有会话级运行锁步骤命中一次
WebElement stale，故不计为 clean；该轮没有菜单断言失败。三轮清理均未报告 fixture、
截图、listener、launcher 或 geckodriver residual。这是虚构 fixture 的日期化证据，
不涉及真实 OpenClaw runtime。

同日独立 review 后的复验进一步要求 Escape 从菜单 action 内起始，并覆盖 desktop
键盘折叠/展开 sidebar、sessions rerender 清除旧 details/active 引用，以及 mobile
history back/popstate/forward 后不复现旧菜单或把焦点送入隐藏 summary。修正后的完整
Firefox suite 为 2/2 clean；此前一次完整复验的 desktop 已通过，mobile 则在场景
watchdog 处丢失 WebDriver session，单独复跑 mobile 通过，故该次不计 clean。新增步骤
后的 mobile watchdog 调整为 25 秒，场景仍受 50 秒测试硬上限与既有有界 cleanup 约束。

2026-08-14 的 #27 有序流式预览以 canonical commit `3db3d00` 为证据快照；虚构
fixture 把一次运行明确建模为
`text(sequence 1) → tool(sequence 2，sequence 3 原地完成) → text(sequence 4)`。
Firefox desktop 场景逐个读取 `.stream-preview .message-body` 的直接子节点并断言精确
DOM 顺序为第一段文本、同一 tool 卡片、第二段文本，并显示固定虚构 tool args；终态仍由完整虚构 transcript 替换
临时预览。完整 browser suite 有界运行三轮，每轮 desktop 与 coarse-mobile 均 2/2 clean
通过（合计 6/6，无 teardown 失败）。server focused regressions 另覆盖连续文本合并、乱序与重连重放收敛、精确
重复不增加 revision、相同 sequence 冲突失败关闭、晚订阅前缀，以及 `replace`/非前缀
快照的单文本降级。该证据只证明 synthetic Gateway 事件中的 ordered text/tool args
到 DOM 的投影。真实 OpenClaw 的跨事件 sequence、delta/replace，以及 upstream
result 字段的 shape/语义均为 `unknown`，仍需 #48 的显式隔离 runtime 验收。当前
panel 对 tool result/stdout 的 live rendering 是 `unsupported`：尚未实现，也不会显示
其正文，需等待 upstream schema 被接受后再实现；因此 #27 仍 open。

2026-08-14 的 #19/#20 会话状态验收以 canonical commit `1f97c0c` 为证据快照，使用
Node.js 22.22.0、Firefox 153.0.1 与 geckodriver 0.37.0 有界执行三轮完整 suite，
每轮 desktop 与 coarse-mobile 均 2/2 clean（合计 6/6，无 teardown 失败）。首轮
RED 在 1120px 复现 activity 已隐藏但 context 仍越出 status 容器；最小 CSS 修复让
可收缩字段正确收缩，并在窄桌面优先隐藏 model 与 setting，没有改变字号、字段顺序、
1120/760 breakpoints、移动端隐藏或完整 `title`。

修复后的真实 Firefox 断言覆盖：长 model 单行、省略号和 subtitle/status 垂直中心；
1121px activity 可见，1120px activity 先隐藏且 context 完整保留，761px context 仍有
可见几何、以省略号收缩并通过 `title` 保留完整值，760px 与 coarse-mobile 隐藏完整
status。上下文数据覆盖初始 12k/200k、不同窗口 9.5k/128k、缺失 usage 的“未知”和
stale usage 的“未知 / 64k”。账户级 `showStatus` false/true 都经保存、刷新和会话重开
确认恢复。

fixture 还把 synthetic compaction 后的 fresh usage characterization 为 2.1k/128k；
这一步没有启动或接触真实 OpenClaw、Gateway、模型或活会话，只证明给定 fixture DTO
的 UI 投影，不能替代或关闭 #21 所要求的 live runtime compaction 验收。

## 自动化矩阵

| 视口 | 输入能力 | 覆盖 |
| --- | --- | --- |
| 桌面 | fine pointer、hover、键盘 | 登录/退出、Origin 与 CSRF 拒绝、会话选择、新建、发送、fork、编辑重发、只读来源、会话级运行锁、停止；会话状态的长 model 单行省略、垂直居中、1120/761 响应式优先级、fresh/unknown/stale 上下文用量和 `showStatus` 刷新恢复；列表行三点菜单首端/下缘/滚动/resize 边界、唯一打开、外部 pointer、菜单 action 内 Escape/焦点、键盘折叠 sidebar 与 rerender stale-state；自动建会话的 composer scope 迁移，accepted/failed/aborted 状态消费与保留边界，附件重试复用；运行中刷新只查询/恢复 durable run，不重复 create，active-other 不继承旧 payload，确认缺失的 provisional 只补建一次，损坏持久值不发请求；外部图片渲染前后零请求，只有跨主机显式链接可脱敏新标签导航，同主机异端口不可导航 |
| 移动 | 500px 以内、coarse pointer、无 hover | Agent → 会话 → 对话导航、真实点击、44px “本轮需要文件”开关、Enter 换行不发送；会话状态完整隐藏；列表行三点菜单首端/末端 viewport 边界、唯一打开、外部 pointer、菜单 action 内 Escape/焦点、history back/popstate/forward stale-state；会话 header 菜单边界；点击发送 |
| 两者共享 | 真实 Firefox DOM、网络与 SSE | 安全 Markdown 不执行 HTML/`javascript:`，附件图片只走已认证同源预览，synthetic SSE 文本/tool args 按 sequence 交错、tool 卡片原地更新、终态替换、终态前断线后的查询恢复 |

fixture 的会话、消息、路径、附件和工具参数均为固定虚构值；桌面外部图片网络断言使用
另一条仅监听 loopback 临时端口的计数 server，只保存精确测试路径的请求次数和
Referer/panel Cookie 是否出现的布尔值，不保存原始请求头。服务端通过监听事件
报告 readiness，测试不依赖固定端口或 readiness sleep。每个场景都会关闭
WebDriver 和 HTTP server，运行中未启动真实 OpenClaw。失败时只在
`browser-artifacts/` 保留包含上述脱敏 fixture 的截图；成功运行不产生截图或
持久状态。CI 失败后只上传固定的 `desktop.png` / `mobile.png`，保留 3 天；
截图不可用时 action 明确告警，而真正的上传失败仍会使上传步骤失败。截图或
WebDriver 清理失败会以不含页面正文、URL、凭据或主机路径的诊断码附加到原始
测试失败，不会覆盖或静默吞掉主错误。

当前 harness 的确定性 teardown 只在 Linux 运行；其它平台会明确跳过，因为
进程归属和监听端口验证依赖 `/proc`。测试先以 detached session 启动一个本地
launcher；launcher 发出 `LAUNCHER_READY` 后仍不创建 target，父进程先捕获其
PID/starttime/session，成功后才发 `START` 创建继承同一 session 的 geckodriver。
捕获失败会发 `ABORT` 并等待未创建 target 的 launcher 关闭，因此不存在
spawn→capture 期间未受监管的 geckodriver 或后代。geckodriver 使用 `--port 0`，
readiness 端口来自 launcher 转发的有界 target stderr/stdout，并通过
`/proc/<pid>/fd` 与 `/proc/net/tcp` 复核监听 socket 属于该 child。WebDriver 使用
不拥有 service 的 external Executor，HTTP `quit` 超时或拒绝只记录阶段；只要
owned process tree 最终确定为空，就不把慢 `quit` 单独判为失败。

场景在首次 await 前安装 `t.after`、watchdog 和 startup token。cleanup 若先于
fixture、driver 或 process supervisor 完成 attach 而启动，会等待 token 在
startup 的 `finally` 中关闭，并纳入窗口内迟到的资源；重复 attach、重复 token 或
cleanup 已关闭后的 attach 均 fail closed。每个资源的 create→attach 还带局部
fallback，保证 attach 自身抛错时立即关闭刚创建的 fixture、停止刚 spawn 的树或
对半建 WebDriver session 发出有界 quit。

Linux supervisor 每次发送 `SIGTERM`/`SIGKILL` 前都按 PID 与 `/proc` starttime
复核 identity，从不向 process group 发信号，也不向复用 PID 发信号。每轮等待都
重新完整扫描 `/proc`，捕获已 reparent 但仍在相同 session 的后代并逐个处理；只有
连续两次完整扫描均无 owned identity 才判定树已清理。最终仍有 identity、identity
不明、完整扫描失败或信号失败都会产生 fatal cleanup diagnostic。

## 验证边界

自动化覆盖 Firefox 的桌面和 coarse-pointer 移动布局，但不声称等同于真实触屏
硬件，也不证明 Chromium/WebKit 的渲染一致性。依赖真实软件键盘、缩放、刘海
安全区或跨浏览器排版的变化仍需相应设备/浏览器验收。#27 的真实跨事件 sequence 与
upstream result 字段 shape/语义仍为 `unknown`；当前 panel 的 tool result/stdout live
rendering 未实现并标为 `unsupported`，#27 仍 open。#19/#20 的 synthetic compaction
也不替代 #21 live compaction。实机 OpenClaw 集成继续使用独立、显式授权的 runtime
acceptance 流程，不能由此 fixture 替代。
