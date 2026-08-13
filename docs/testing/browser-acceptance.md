# 浏览器自动化验收

> **当前自动化与日期化证据元数据**
>
> - Date: `2026-08-12`（初始自动化）、`2026-08-13`（#43 网络边界复验、
>   #49 composer 状态迁移 characterization、browser run 刷新恢复回归）
> - ark-panel commit: `3a29ee4`（初始自动化）、`cfe53d9`（外部图片边界）、
>   `61cc824`（#49 characterization 的基线）、`2e86ed8`（刷新恢复修复的
>   集成基线；修复、测试与本文件随同一后续 commit 提交）
> - OpenClaw version: 不适用（虚构本地 browser fixture）
> - Status: runbook `current automated`；2026-08-12 result `historical pass`；
>   2026-08-13 #43 result `partial`；2026-08-13 #49 result `historical pass`；
>   browser run 刷新恢复 scope `current automated`
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

2026-08-13 的 #49 composer 状态迁移 characterization 使用 Node.js 22.22.0、
Firefox 153.0.1 与 geckodriver 0.37.0，在 `61cc824` 基线上有界执行三轮完整
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

刷新恢复修复集成在 `2e86ed8` 基线上，使用 Node.js 22.22.0、Firefox 153.0.1 与
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

## 自动化矩阵

| 视口 | 输入能力 | 覆盖 |
| --- | --- | --- |
| 桌面 | fine pointer、hover、键盘 | 登录/退出、Origin 与 CSRF 拒绝、会话选择、新建、发送、fork、编辑重发、只读来源、会话级运行锁、停止、上下文 `k` 展示、三点菜单边界；自动建会话的 composer scope 迁移，accepted/failed/aborted 状态消费与保留边界，附件重试复用；运行中刷新只查询/恢复 durable run，不重复 create，active-other 不继承旧 payload，确认缺失的 provisional 只补建一次，损坏持久值不发请求；外部图片渲染前后零请求，只有跨主机显式链接可脱敏新标签导航，同主机异端口不可导航 |
| 移动 | 500px 以内、coarse pointer、无 hover | Agent → 会话 → 对话导航、真实点击、44px “本轮需要文件”开关、Enter 换行不发送、三点菜单边界、Escape 关闭并恢复焦点、点击发送 |
| 两者共享 | 真实 Firefox DOM、网络与 SSE | 安全 Markdown 不执行 HTML/`javascript:`，附件图片只走已认证同源预览，SSE 文本与工具阶段、终态替换、终态前断线后的查询恢复 |

fixture 的会话、消息、路径、附件和工具结果均为固定虚构值；桌面外部图片网络断言使用
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
安全区或跨浏览器排版的变化仍需相应设备/浏览器验收。实机 OpenClaw 集成继续
使用独立、显式授权的 runtime acceptance 流程，不能由此 fixture 替代。
