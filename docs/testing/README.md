# Acceptance evidence and current matrix

本目录同时保存三类用途不同的文档：

- **runbook** 说明如何执行一项验收。它本身不是执行结果，也不能把未执行项记为
  已支持。
- **dated evidence** 记录某天、某个 ark-panel commit、某个 OpenClaw 版本和明确
  环境中的观察结果。后来新增的能力不得回填进较早的记录；历史文件只补充元数据、
  当前适用性提示和本矩阵链接。
- **current matrix** 是下面这份当前状态快照。只有标为 `current automated` 的范围会
  随仓库自动化持续执行；其它状态必须按对应证据的日期和作用域理解。

本矩阵更新于 2026-08-14。既有行仍以各自行内 commit 为实现或证据快照；#41 的
fixture 生命周期重复验收以 ark-panel `9663899` 为实现快照，#19/#20 浏览器验收以
`3db3d00` 为隔离 worktree 基线（修复、测试与证据随同一后续 commit 提交）。表中的 commit 是产生
证据或引入当前自动检查的代码 commit，不是本文档自己的 commit。#41 与 #47 都没有
运行真实 OpenClaw、Gateway、模型或真实活会话验收。

## Status vocabulary

状态列只能使用以下值：

- `current automated`：列出的确定性命令在当前仓库自动执行或可本地重复；结论只覆盖
  表中 scope，不外推到真实部署或真实 OpenClaw。
- `historical pass`：指定日期和版本下曾通过；不是当前版本的持续保证。
- `partial`：同一验收的部分断言通过，但至少一个要求失败、未完成或被清理故障中断。
- `failed`：指定验收中的必要断言明确失败。
- `unsupported`：产品边界或安全 gate 明确不支持该操作；不能解释成“尚未测试”。
- `unknown`：没有足够证据判断，或当前实现变更后尚未做对应的真实复验。

## Current automated matrix

| Capability | Status | Evidence kind | Command | Date | Panel commit | OpenClaw version | Scope | Link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Strict server/storage/gateway/domain TypeScript | `current automated` | Node 22 static check；CI baseline | `npm run typecheck` | 2026-08-13 | `cfe53d9` | 不适用 | 严格 TypeScript；不执行运行时或浏览器路径 | [CI](../../.github/workflows/ci.yml) |
| First-party frontend JavaScript types | `current automated` | `checkJs` static check；CI baseline | `npm run check:frontend` | 2026-08-13 | `cfe53d9` | 不适用 | `src/frontend/` 八个第一方脚本；不是浏览器动态覆盖率 | [CI](../../.github/workflows/ci.yml) |
| Core compiled `node:test` suite | `current automated` | deterministic unit/integration fixtures；CI baseline | `npm test` | 2026-08-13 | `cfe53d9` | 不适用 | 构建后的 server、storage、gateway adapter、domain 和静态 frontend 合同；不连接真实 Gateway | [CI](../../.github/workflows/ci.yml) |
| Stream/CLI/generation/bridge fixture lifecycle | `current automated` | deterministic repeated `node:test` runner；日期化 20×2 pass | `npm run build && node scripts/test-fixture-lifecycle.mjs --runs 20` | 2026-08-13 | `9663899` | 不适用 | 四个精确编译测试；每轮隔离 TMPDIR、root 删除确认与 owned-process 检查；不连接真实 Gateway | [2026-08-13 evidence](fixture-lifecycle-acceptance-2026-08-13.md) |
| Server-side coverage baseline | `current automated` | Node 22 built-in coverage；独立 CI job | `npm run test:coverage` | 2026-08-12 | `44b8c27` | 不适用 | 动态 core inventory、单 test context 与固定阈值；不含浏览器 JavaScript 动态覆盖 | [coverage contract](../coverage.md) |
| Firefox desktop/coarse-pointer automation | `current automated` | real Firefox/WebDriver against fictional local fixture；CI baseline | `npm run test:browser` | 2026-08-14 | `3db3d00`（修复/测试同一后续 commit） | 不适用 | Firefox DOM、网络、SSE、桌面与 500px coarse-pointer emulation；含会话状态 geometry、响应式优先级、usage DTO 和账户设置恢复，不等同实机触屏或 live runtime | [current browser automation](browser-acceptance.md) |
| External Markdown image consent and network boundary | `current automated` | frontend unit contracts + Firefox loopback request probe | `npm test && npm run test:browser` | 2026-08-13 | `cfe53d9` | 不适用 | 未同意时不加载外部图片；仅显式跨主机链接可脱敏导航；同主机异端口仍拒绝 | [browser evidence](browser-acceptance.md) |
| Durable run journal, idempotent recovery, and complete transcript commit | `current automated` | filesystem and lifecycle fixtures | `npm test` | 2026-08-13 | `cfe53d9` | 不适用 | 当前 `PanelRunStore`/generation 路径；不证明真实 Gateway 故障后的跨进程追单 | [generation tests](../../test/generation-api.test.ts) |
| Deployment lifecycle fixture | `current automated` | spawned local panel process with fictional data；独立 CI job | `npm run test:deployment` | 2026-08-13 | `cfe53d9` | 不适用 | health、login、write、SIGTERM、restart；不启动 OpenClaw | [operations runbook](../operations/deployment-and-backup.md) |
| Offline backup / verify / restore fixture | `current automated` | temporary filesystem fixture in deployment job and core tests | `npm run test:deployment` | 2026-08-13 | `cfe53d9` | 不适用 | 面板拥有的数据目录、完整性校验和新目录恢复；不是生产备份演练 | [operations runbook](../operations/deployment-and-backup.md) |
| Reverse-proxy Host/Origin policy | `current automated` | deterministic HTTP/config/deployment fixtures | `npm test && npm run test:deployment` | 2026-08-13 | `67093c8` | 不适用 | `PANEL_PUBLIC_ORIGIN`、精确 trusted hosts、CSRF/Origin 和 Secure cookie；不含真实 nginx/TLS | [deployment tests](../../test/deployment.test.ts) |
| Gateway exact three-scope hello and RPC allowlist | `current automated` | fake WebSocket protocol tests | `npm test` | 2026-08-13 | `50d9117` | `2026.6.11` protocol fixture | hello 必须精确返回 `operator.read/write/admin`，16 个本地 RPC 默认拒绝未知方法；不证明真实 Gateway 授权 | [protocol tests](../../test/stream-client.test.ts) |
| Panel-managed memory consolidation transactions | `current automated` | deterministic store/API fixtures | `npm test` | 2026-08-13 | `cfe53d9` | 不适用 | 候选、确认、atomic write、checkpoint、restore/rebuild 与工具拒绝路径；模型/runtime 另见历史证据 | [memory tests](../../test/memory-consolidation-api.test.ts) |

`current automated` 表示当前存在持续的自动检查，不表示本文档工作项重新执行了这些
命令。CI 的一次具体 run 仍应以对应 run 的 commit 和结果为准。

## Dated, live, and unsupported matrix

| Capability | Status | Evidence kind | Command | Date | Panel commit | OpenClaw version | Scope | Link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Historical Firefox desktop/mobile fixture | `historical pass` | manual Firefox 152/WebDriver with fictional in-memory fixture | `npm run build`，再运行 fixture 并手工驾驶 WebDriver | 2026-07-11 | `cf67b56` | 不适用 | 当时的登录、导航、会话、SSE 和安全渲染；不含后来 slash command、自动化或外部图片能力 | [2026-07-11 evidence](browser-acceptance-2026-07-11.md) |
| Initial automated Firefox suite | `historical pass` | real Firefox 153.0.1 + geckodriver 0.37.0，三轮 2/2 | `npm run test:browser` | 2026-08-12 | `3a29ee4` | 不适用 | 当时自动化矩阵；三轮结束无 fixture-owned residual | [browser evidence](browser-acceptance.md) |
| #43 external-image Firefox repetitions | `partial` | real Firefox 153.0.1 + geckodriver 0.37.0，local network probes | `npm run test:browser` | 2026-08-13 | `cfe53d9` | 不适用 | 三轮功能断言均完成且网络边界符合预期；仅一轮 2/2 clean，另外两轮命中 `DRIVER_QUIT_FAILED` | [browser evidence](browser-acceptance.md) |
| #19/#20 conversation-status Firefox repetitions | `historical pass` | real Firefox 153.0.1 + geckodriver 0.37.0 against fictional fixture，三轮 2/2 | `npm run test:browser` | 2026-08-14 | `3db3d00`（修复/测试同一后续 commit） | 不适用 | 长 model geometry、1120/761/760 响应式、fresh/unknown/stale usage、`showStatus` 刷新恢复；synthetic compaction 仅 UI characterization，不替代 #21 live | [browser evidence](browser-acceptance.md) |
| Chromium/WebKit rendering and interaction | `unknown` | no dated evidence | 未提供 | 未执行 | `cfe53d9` | 不适用 | 当前没有 Chromium/WebKit 自动化或人工结果 | [browser boundary](browser-acceptance.md#验证边界) |
| Physical touchscreen, software keyboard, zoom, and safe-area behavior | `unknown` | no device evidence | 未提供 | 未执行 | `cfe53d9` | 不适用 | 500px coarse-pointer emulation 不能替代真实触屏硬件 | [browser boundary](browser-acceptance.md#验证边界) |
| Production reverse proxy with nginx and real TLS | `unknown` | deployment runbook only | 按部署 runbook 手工验收；本工作项未执行 | 未执行 | `67093c8` | 不适用 | 真实 proxy header、证书终止、SSE 与 Secure cookie | [deployment runbook](../operations/deployment-and-backup.md) |
| Live Gateway exact `operator.read/write/admin` authorization | `unknown` | current implementation + fake protocol evidence only | `npm run test:stream-probe`（需显式授权；#42 后尚无真实结果） | 未执行 | `50d9117` | 目标 `2026.6.11` | 无渠道绑定测试 agent；须验证真实 hello 与所需 RPC，不得用 fake 结果代替 | [stream probe runbook and old evidence](streaming-acceptance.md) |
| Live Gateway read-scope streaming probe | `historical pass` | isolated live `paneltest` probe | `npm run test:stream-probe` | 2026-07-17 | `ccd8b20` | `2026.6.11` | 当次只证明 `operator.read`、3 个文本事件、1 组 tool start/end；已被当前三-scope 控制连接取代 | [2026-07-17 evidence](streaming-acceptance.md) |
| Pre-journal abort, cleanup, and durability fixtures | `historical pass` | deterministic in-memory/temporary-directory fixtures | 当时的 `npm test` 与 `npm run test:deployment` | 2026-07-12 | `cf67b56` | 不适用 | 只描述当时的断线 abort、内存 completed cache 和无 run journal 架构；当前 durable journal 另见自动化矩阵 | [2026-07-12 evidence](durability-results.md) |
| `panel-claude-runtime` bootstrap injection and `memory_search` | `historical pass` | isolated live runtime | `npm run test:runtime-acceptance -- panel-claude-runtime` | 2026-07-12 | `cf67b56` | `2026.6.11` | 当次 bootstrap 5/5、memory nonce 0 results、workspace hash unchanged | [2026-07-12 evidence](runtime-acceptance-2026-07-12.md) |
| `panel-main-runtime` bootstrap injection and `memory_search` | `failed` | isolated live runtime | `npm run test:runtime-acceptance -- panel-main-runtime` | 2026-07-12 | `cf67b56` | `2026.6.11` | 当次 bootstrap 0/5；memory tool 存在不能替代 bootstrap 注入证明 | [2026-07-12 evidence](runtime-acceptance-2026-07-12.md) |
| Current `panel-claude-runtime` bootstrap/memory behavior | `unknown` | current runbook + superseded historical pass | `npm run test:runtime-acceptance -- panel-claude-runtime`（需显式授权） | 未执行 | `cfe53d9` | 目标 `2026.6.11` | 当前 #42 控制连接后的真实复验尚未执行；不能沿用 2026-07-12 结果 | [runtime runbook](runtime-acceptance.md) |
| Current `panel-main-runtime` bootstrap/memory behavior | `unknown` | current runbook + superseded historical failure | `npm run test:runtime-acceptance -- panel-main-runtime`（需显式授权） | 未执行 | `cfe53d9` | 目标 `2026.6.11` | 当前 #42 控制连接后的真实复验尚未执行；历史失败也不能推断当前结果 | [runtime runbook](runtime-acceptance.md) |
| Current `paneltest` bootstrap/memory behavior | `unknown` | current runbook, no current result | `npm run test:runtime-acceptance -- paneltest`（需显式授权） | 未执行 | `cfe53d9` | 目标 `2026.6.11` | runbook 允许的第三个 runtime，须独立证明，不能从其它 runtime 推广 | [runtime runbook](runtime-acceptance.md) |
| `panel-claude-runtime` isolation from a concurrently active source | `partial` | isolated live generation, three calls | `npm run test:panel-claude-runtime` | 2026-07-11 | `cf67b56` | `2026.6.11` (`e085fa1`) | 专用 runtime 清理通过；真实 source 同期被外部写入，整目录不变性无法严格证明 | [isolation evidence](runtime-isolation-results.md) |
| OpenClaw internal recall statistics/persistence outside cleaned artifacts | `unknown` | observation boundary in live runtime evidence | 无可证明不存在性的仓库命令 | 2026-07-12 | `cf67b56` | `2026.6.11` | 一次性 transcript/trajectory 已清理，但共享内部状态是否记录 recall 统计未确认 | [runtime evidence](runtime-acceptance-2026-07-12.md) |
| Memory candidate generation and confirmed consolidation with isolated memory runtimes | `historical pass` | live isolated runtime + fictional source; one closed-loop confirmation and two candidate-only runs | 未保留为单一可重放仓库命令；必须按证据边界重新设计显式 gate 后复验 | 2026-07-22 | `218bbef` | `2026.6.11` | `panel-memory-claude`、`panel-memory-main`；零 bindings、限定有效工具、workspace/source unchanged | [2026-07-22 evidence](memory-runtime-acceptance-2026-07-22.md) |
| Current memory-runtime live generation/consolidation | `unknown` | deterministic transactions current；live result historical only | 未提供当前显式 gate；不得用普通测试触发 | 未执行 | `cfe53d9` | 目标 `2026.6.11` | 当前 memory runtime、effective tools、模型候选和 workspace 隔离尚未实机复验 | [historical evidence](memory-runtime-acceptance-2026-07-22.md) |
| Direct write to existing active/reset source sessions | `unsupported` | live preflight stopped before any write | `scripts/live-session-write-smoke.sh`（只可在用户指定双目标并完整确认后运行） | 2026-07-12 | `cf67b56` | `2026.6.11` (`e085fa1`) | 当次因目标不明确在 0 RPC/0 transcript mutation 停止；产品仍将 active/reset source 视为只读 | [zero-write evidence](live-session-write-results.md) |

## Document index

Runbooks:

- [`runtime-acceptance.md`](runtime-acceptance.md) — 当前专用 runtime 兼容性流程，
  **不是结果**。
- [`browser-acceptance.md`](browser-acceptance.md) — 当前 Firefox 自动化运行说明，
  同时包含 2026-08-12 与 2026-08-13 的日期化结果。

Dated evidence:

- [`browser-acceptance-2026-07-11.md`](browser-acceptance-2026-07-11.md)
- [`durability-results.md`](durability-results.md)
- [`live-session-write-results.md`](live-session-write-results.md)
- [`runtime-acceptance-2026-07-12.md`](runtime-acceptance-2026-07-12.md)
- [`runtime-isolation-results.md`](runtime-isolation-results.md)
- [`streaming-acceptance.md`](streaming-acceptance.md)
- [`memory-runtime-acceptance-2026-07-22.md`](memory-runtime-acceptance-2026-07-22.md)
- [`fixture-lifecycle-acceptance-2026-08-13.md`](fixture-lifecycle-acceptance-2026-08-13.md)

执行任何 live 命令前都必须重新阅读对应 runbook 和仓库根部 `AGENTS.md`。普通文档
维护、CI 或本矩阵更新不得自动触发 live/runtime/probe 命令。
