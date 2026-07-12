# 真实活会话写入验收记录

日期：2026-07-12
OpenClaw：2026.6.11（e085fa1）

## 本次结果：预检阻断，未发送

用户已明确授权分别向 `claude`、`main` 的真实活会话发送一条受控验收消息。但发送前的只读检查发现：

- `claude` 只有一个登记会话，状态为 `done`，最近渠道为 Telegram direct，存在 delivery context；agent 有 Telegram 和飞书两个 bindings。
- `main` 有 14 个登记会话，但 agent 当前 bindings 为 0。最近的普通候选 `agent:main:main` 状态为 `failed`，最近渠道标记为 webchat，且没有 `lastTo`。其余带 Telegram key 的记录是较旧的 group/topic 或 slash 会话，不能在没有用户指定目标的情况下擅自选择。

因此无法把 `main` 候选认定为“健康、明确、可投递的真实活会话”。按照“任一预检异常立即停”的约束，本轮在第一条发送前停止：

- 发送 RPC：0 次；
- 真实 transcript 变化：无本次验收造成的变化；
- Telegram / 飞书触达：无；
- 跨 agent/session 串写：未发生；
- `/reset`、`/compact`、配置修改和真实 session 清理：均未执行。

## 显式 gate 脚本

`scripts/live-session-write-smoke.sh` 不会自动选择会话。它要求操作者显式提供两个 session key 和 sessionId，并输入完整确认短语；两个目标必须在任何写入前同时通过版本、ID、agent、`done`、direct chat、delivery context 和 transcript 安全检查。任何一项失败都会在 0 写入时退出。

脚本属于真实外部副作用验收，不能加入普通测试套件，也不能由 systemd 自动运行。重新验收前，需要用户明确指出 `main` 应使用哪个 direct 会话，或先让 `main` 的正常客户端产生一个健康、明确的活会话。
