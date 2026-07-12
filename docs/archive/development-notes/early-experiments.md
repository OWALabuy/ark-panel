# 第 0 段：推理桥接实测记录

实测日期：2026-07-11
OpenClaw CLI / gateway：2026.6.11（e085fa1）
测试 agent：`paneltest`

## 安全核对

- gateway 正常运行，仅监听 `127.0.0.1:18789`，配置中存在固定 token。
- 新建了独立的 `paneltest`，workspace 为 `~/paneltest-workspace`，会话目录为 `~/.openclaw/agents/paneltest/sessions/`。
- `paneltest` 没有任何 channel binding；没有执行 `agents bind`。
- 创建前后，`claude`、`main`、全部 channels、非 paneltest bindings 的规范化 JSON 哈希逐项相同。
- 未读取或修改 `~/claude`、`~/.openclaw/agents/claude/sessions/` 的内容；未修改真实渠道配置；未提交或推送 git。

## 结论摘要

桥接可行，但规格里的定位流程需要修改。可行流程是：

1. 调官方 `sessions.create`，让 gateway 登记一次性的临时 session 并创建 transcript。
2. 面板只覆盖该 session 的 transcript，写入截至上一轮完整 assistant/run 的历史；不写 `sessions.json`。
3. 调 `sessions.send`，把尚未写入临时 transcript 的最新用户消息作为本轮 message 提交。
4. 等 `sessions.describe` 的状态结束，再从临时 transcript 读取本轮新增的完整 entries。

直接预先放置 `<指定 sessionId>.jsonl`，再对一个未登记的 sessionKey 调 `chat.send` 并传 `sessionId`，实测失败：gateway 另生成了 UUID 和 transcript，模型明确表示没读到预置历史。

## 分项结果

### 1. gateway 读取预置历史：通过（需先 create）

通过 `sessions.create` 得到 sessionId 后，把两轮脱敏历史写入其 transcript，其中虚构口令为“银色河狸九号”。随后用 `sessions.send` 询问口令，模型准确回答“银色河狸九号”。

这证明 gateway 会读取已登记 session 对应的、由面板物化的 transcript。

### 2. 最新用户消息不重复：通过（规格原步骤应改）

工作路径中，物化历史停在上一条完整 assistant entry；最新用户消息只通过 `sessions.send.message` 提交。最终 transcript 中该用户消息恰好一条。

“先把最新用户消息写进 transcript，再不传 message 触发推理”不可用，因为 `chat.send` / `sessions.send` 要求非空 message。面板搬回新增 entries 时，应跳过 gateway 新增的用户 entry，只复制它后面的 run entries；同时校验内容和 idempotencyKey。

### 3. 完整工具 run：通过

在 workspace 放置只含 `PANELTEST_TOOL_MARKER_7F3A` 的测试文件，要求模型必须用只读 `read` 工具读取。临时 transcript 依次出现：

- user message
- assistant `toolCall`（工具名 `read`）
- 独立的 `toolResult`
- 最终 assistant（正确返回标记）
- `openclaw:bootstrap-context:full` custom entry

`sessions.send` 的直接响应只有 `{runId, status:"started", messageSeq}`，不足以重建 run。可靠方法是等待 session 结束，再读取 transcript 新增的完整 JSONL 行。

另有一个限制：覆盖过的临时 session 完成一轮后，再复用它发送第二轮，实测报 `reply session initialization conflicted`。2a′ 应严格采用“一次推理一个临时 session”，不要复用。

### 4. abort / 断线 / 进程退出：部分通过

- `sessions.abort`：通过。RPC 返回 `status:"aborted"`；transcript 留下结构完整的 assistant entry，`stopReason:"aborted"`，content 为空，没有半行 JSON。
- 客户端断开 / 进程退出：基础行为通过。`openclaw gateway call sessions.send` 收到 started 后客户端即退出，gateway 仍独立完成推理并写完 transcript。这与面板进程在提交后断开的传输条件相同。
- 强制杀死自定义 WebSocket 客户端的逐事件恢复：尚未用专用客户端复测。
- 未重启 gateway；重启会短暂影响真实渠道，不应在无人确认时执行。

面板自己的权威 transcript 不应边流边追加。只有临时 session 状态为 done 且新增 entries 校验完整后，才整组提交；abort/failed 只保存面板侧失败状态。

### 5. 临时工作区清理：失败

存在官方 `sessions.delete`，并能移除 `sessions.json` 条目。但 `deleteTranscript:true` 的实际语义是把 transcript 改名为 `.jsonl.deleted.<timestamp>`，不是删除；同时 `.trajectory.jsonl` 和 `.trajectory-path.json` 仍留在 sessions 目录。

因此单靠官方删除 RPC 无法做到“无文件残留”。若长期采用 2a′，还需要 OpenClaw 提供真正删除临时 session 全部 artifacts 的接口，或明确授权面板在官方注销后按 sessionId 删除 paneltest 专用目录中的 transcript 归档和 trajectory 文件。后者依赖内部文件命名，稳定性较差。

本次实验收尾时，先逐条调用官方 `sessions.delete` 注销，再只在 `paneltest/sessions/` 内人工删除这些已确认属于实验的残留。最终 `sessions.json` 为 `{}`、会话数为 0，目录中没有测试 transcript 或 trajectory。这个人工收尾证明残留可以由直接文件操作清掉，但不改变“官方清理接口本身不完整”的结论。

### 6. 连续 20—30 次累积：未完成完整推理循环

目前已确认每次成功推理至少产生 transcript、trajectory pointer、trajectory JSONL 三类文件；官方删除后 transcript 变成归档，trajectory 仍保留。因此无需跑满 20 次也能确定文件会线性累积。

尚未执行 20—30 次完整模型推理，以避免在清理策略已经明确失败后继续制造残留和无必要调用。若 Owl 仍要取得定量数据，应先决定是否允许实验脚本在每次官方注销后删除 `paneltest` 的这些 artifacts，再跑耐久测试。

### 7. 系统文件 / 记忆 / skills 注入：部分通过

- `USER.md`：通过。写入虚构代号“琥珀海鸥四号”后，新 session 在不调用工具的情况下准确回答该代号，证明 paneltest workspace 的 bootstrap 文件被注入。
- `SOUL.md`、`MEMORY.md`：已放置脱敏 fixture；尚未分别做独立盲测。
- 工具：`read` 已实际调用并成功，证明完整工具链至少包含 workspace 文件读取。
- `memory_search`、recall store 新增、browser/canvas、skills：尚未逐项触发。不能仅凭工具目录存在判定通过。

## 其它观察

- `sessions.create` 创建的 header `cwd` 实测为 `/home/owalabuy`，但 agent 的 bootstrap 和工具仍按 `paneltest` workspace 工作。面板物化 transcript 时应使用 paneltest workspace 路径。
- gateway 会在 run 前后补入 `thinking_level_change` 和 custom entries；搬运时不能只取 message。
- user entry 的 `message.content` 实测可以是字符串，而 assistant/tool entries 通常是 content block 数组。解析器不能假定所有 message content 都是数组。
- OpenClaw 还会生成 trajectory 文件；原规格的临时 artifact 清单漏掉了它们。

## 复现脚本

最小复现在 `experiments/bridge-zero.sh`。脚本开头会检查固定 token 和 paneltest bindings；只操作 paneltest。它会留下官方删除产生的归档和 trajectory，运行前应先理解上述清理结论。

## 当前架构判断

“预置历史 → gateway 推理 → 取得完整 run”已经成立；官方接口单独不能清净删除临时 artifacts。Owl 已决定不维护 OpenClaw 补丁，采用专用无渠道 runtime agent，并在官方注销后执行严格受限的 artifact 清理。正式适配层的复测结果如下。

## 正式适配层复测（2026-07-11）

正式工程中的 CLI RPC 适配层已经在 `paneltest` 跑通一次完整流程：创建一次性 session、原子物化历史、发送消息、等待完成、读取新增 entries、官方注销、受限清理。该次 run 取得 4 条新增 entry。结束后 `paneltest` 的 sessions 目录只剩 `sessions.json`，其内容为 `{}`，没有 transcript 或 trajectory 残留。

复测还发现：gateway 在 user entry 前可能先追加 `thinking_level_change` 等控制 entry，因此不能假定新增部分的第一行一定是 user。适配层现在会在新增部分中查找唯一 user entry、校验消息内容、移除这条重复 user，并把直接子 entry 的 `parentId` 从 gateway 生成的 user ID 改接到面板保存的 user ID。否则面板 transcript 的祖先链会在本轮 user 与 assistant 之间断开。

当前适配使用 OpenClaw 自带 CLI 发 RPC，不通过 shell；它只支持固定版本 `2026.6.11`。HTTP 层暂时只能在完成后发送 SSE `run.completed`，没有逐 token 的 `run.delta`。若以后改用 WebSocket 事件流，bridge 和存储接口无需改变。
