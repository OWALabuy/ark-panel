# 浏览器自动化验收

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

## 自动化矩阵

| 视口 | 输入能力 | 覆盖 |
| --- | --- | --- |
| 桌面 | fine pointer、hover、键盘 | 登录/退出、Origin 与 CSRF 拒绝、会话选择、新建、发送、fork、编辑重发、只读来源、会话级运行锁、停止、上下文 `k` 展示、三点菜单边界；外部图片渲染前后零请求，只有跨主机显式链接可脱敏新标签导航，同主机异端口不可导航 |
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

## 验证边界

自动化覆盖 Firefox 的桌面和 coarse-pointer 移动布局，但不声称等同于真实触屏
硬件，也不证明 Chromium/WebKit 的渲染一致性。依赖真实软件键盘、缩放、刘海
安全区或跨浏览器排版的变化仍需相应设备/浏览器验收。实机 OpenClaw 集成继续
使用独立、显式授权的 runtime acceptance 流程，不能由此 fixture 替代。
