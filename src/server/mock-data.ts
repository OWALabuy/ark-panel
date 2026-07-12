export const mockAgents = [
  { id: "claude", label: "Claude", unread: true }, { id: "main", label: "Main", unread: false }, { id: "paneltest", label: "Panel Test", unread: false }
];
export const mockSessions = [
  { recordId: "welcome", agentId: "claude", title: "会话连续性面板", updatedAt: "刚刚", messageCount: 4, kind: "panel", unread: true },
  { recordId: "fork-design", agentId: "claude", title: "Fork 数据模型", updatedAt: "昨天", messageCount: 8, kind: "panel", forkedFrom: "架构讨论" },
  { recordId: "archive", agentId: "claude", title: "旧会话归档", updatedAt: "3 天前", messageCount: 12, kind: "reset" },
  { recordId: "main-notes", agentId: "main", title: "Main 的笔记", updatedAt: "今天", messageCount: 3, kind: "active" }
];
export const mockConversation = { recordId: "welcome", title: "会话连续性面板", messages: [
  { id: "u1", role: "user", blocks: [{ type: "text", text: "我们把会话入口整理成一个真正顺手的面板。" }] },
  { id: "a1", role: "assistant", blocks: [{ type: "thinking", text: "梳理信息架构与安全边界。" }, { type: "tool_use", name: "read_transcript", input: { recordId: "welcome" } }, { type: "text", text: "三栏结构已经就位。工具与思考默认折叠，手机上则变成逐层导航。" }] },
  { id: "u2", role: "user", blocks: [{ type: "text", text: "安全边界呢？" }] },
  { id: "a2", role: "assistant", blocks: [{ type: "text", text: "服务只监听本机；登录态使用 HttpOnly Cookie，所有修改请求还必须同时通过同源和 CSRF 校验。" }] }
] };
