# 斜杠命令首版决定

日期：2026-07-12

## 结论

首版会话面板不实现 OpenClaw 斜杠命令。面板移除 `/reset`、`/compact` 快捷入口，并拒绝把以 `/` 开头的输入当作普通模型消息发送。

这不是只推迟两个命令。OpenClaw `2026.6.11` 当前运行时注册了 48 个核心命令、59 个文本别名；此外还有随渠道、插件和 skill 动态变化的命令。命令可用性还受配置、surface、owner 身份和当前 run 状态影响，不能在面板里硬编码一份静态子集。

## 当前面板为什么不能透明支持命令

面板的推理桥接为每一轮创建一次性 runtime session，物化历史、执行一次 `sessions.send`，搬回新增 transcript 后注销并清理 runtime session。普通对话已经实测可用，但完整命令语义依赖 gateway 的会话和命令分派状态：

- `/model`、`/think`、`/queue` 等设置需要跨轮持久化；
- `/compact`、`/reset`、`/new` 会改变 gateway session 或 transcript 生命周期；
- `/stop`、`/steer` 需要定位正在运行的 run；
- `/config`、`/plugins`、`/restart`、`/bash` 等涉及 owner 权限或全局状态；
- 插件、skill 和 dock 命令是动态注册的。

若仅把命令字符串送进当前普通消息接口，部分命令的状态会随临时 session 被删除，部分命令会破坏增量 transcript 假设，也无法保证权限和返回结果正确。因此首版不提供不完整或看似可用的命令入口。

## 后续适配原则

后续方案由 Owl 与 Claude 另行讨论。无论选择何种实现，都应满足：

1. 命令目录和可用性来自 gateway，而不是面板硬编码。
2. 命令由 gateway 的官方命令分派执行，面板不复制命令业务逻辑。
3. 保留 gateway 的配置开关、owner 权限和 surface 限制。
4. 明确定义会话级设置如何跨一次性 runtime session 持久化，或改用长期 runtime session。
5. 对 `/stop`、`/steer` 等活动 run 命令建立单独的 run 路由。
6. OpenClaw 升级后重新读取并验证命令面。

## 首版用户可见行为

- 输入普通消息：按既有隔离 runtime 桥接执行。
- 输入以 `/` 开头的内容：服务端返回 `SLASH_COMMANDS_UNSUPPORTED`，不调用 gateway、不写入 panel transcript。
- 如需执行 OpenClaw 命令：暂时继续在原有 Telegram、飞书、TUI 或其他 OpenClaw surface 中执行。
