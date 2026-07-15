# 首版完成清单

## 已完成

- 账号密码登录、CSRF、Host/Origin 限制、限速、退出登录与 localhost-only 监听。
- 真实 agent active transcript 与 OpenClaw reset 归档只读浏览；panel 数据目录独立。
- 多 agent、会话列表、来源标记、全文搜索、revision 轮询与移动端逐层导航。
- panel 会话新建、完整 transcript 展示、专用 runtime 推理、SSE 生命周期、停止生成、错误重试与幂等键。
- 从合法边界 fork、编辑用户消息后派生分支；不修改来源 transcript。
- thinking、tool use、tool result 安全 DOM 渲染并默认折叠。
- 消息安全 Markdown、代码高亮与本地 KaTeX 数学公式渲染；支持四种常用公式定界符，失败时保留原文且不依赖 CDN。
- 上下文预算保护、原子 transcript 提交、runtime artifact 受限清理。
- 首版不显示斜杠命令入口；客户端和服务端均阻止 `/...` 进入普通推理桥接。
- 备份/校验/恢复工具、systemd 示例、部署 smoke 和纯 fixture 浏览器验收。

## 明确不在首版

- 向真实 active 会话发送消息；它们在面板中只读。
- `/reset`、`/compact` 或其他 OpenClaw 斜杠命令。
- 逐 token 输出；当前 SSE 提供 run 生命周期，完成后整组刷新。
- 自动压缩或模型摘要；超预算时拒绝并建议从较早位置 fork。

## 上线前需要用户参与

1. 提供生产用户名、密码哈希和至少 32 字符的随机 session secret。
2. 确认 `PANEL_READ_AGENTS` 的真实只读目录，以及各 agent 对应的无渠道专用 runtime。
3. 在用户在场时运行 `npm run test:app-paneltest`；它会产生一次真实模型调用，但不应投递到任何渠道。
4. 决定是否启用 systemd 用户服务、SSH 隧道或 HTTPS 反向代理，并据此设置 Secure Cookie。
5. 选择备份目录和保留策略；任何远端备份必须先加密。
