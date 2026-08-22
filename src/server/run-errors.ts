const PUBLIC_RUN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  RUN_ABORTED: "任务已停止。",
  SESSION_BUSY: "该会话正在生成。",
  REVISION_CONFLICT: "会话已更新，请刷新后重试。",
  PANEL_SESSION_NOT_FOUND: "面板会话不存在。",
  RUNTIME_NOT_CONFIGURED: "Agent 推理 runtime 未配置。",
  IDEMPOTENCY_KEY_REUSED: "重试标识已用于其他请求。",
  SLASH_COMMANDS_UNSUPPORTED: "请通过结构化命令入口执行斜杠命令。",
  GATEWAY_RUN_TIMEOUT: "OpenClaw 运行超时，未提交不完整结果。",
  ATTACHMENTS_INVALID: "附件列表无效，请重新选择。",
  ATTACHMENTS_TOO_LARGE: "单次附件总量不能超过 15 MiB。",
  ATTACHMENT_ALREADY_ASSIGNED: "附件已属于历史消息，请重新上传后发送。",
  ATTACHMENT_NOT_OWNED_BY_SESSION: "附件不属于当前会话，请重新选择。",
  GATEWAY_ATTACHMENT_TRANSPORT_UNAVAILABLE: "附件传输通道不可用，请检查 OpenClaw Gateway 认证配置。",
  GATEWAY_CONNECTION_CLOSED: "OpenClaw Gateway 控制连接已断开，请稍后重试。",
  GATEWAY_HANDSHAKE_DENIED: "OpenClaw Gateway 拒绝了控制连接，请检查认证配置。",
  GATEWAY_REQUEST_DENIED: "OpenClaw Gateway 拒绝了控制请求。",
  GATEWAY_REQUEST_TIMEOUT: "OpenClaw Gateway 控制请求超时，请稍后重试。",
  GATEWAY_RPC_METHOD_NOT_ALLOWED: "该 Gateway 方法未在当前版本允许列表中。",
  GATEWAY_SCOPE_CONTRACT_VIOLATION: "OpenClaw Gateway 权限契约不匹配。",
  GATEWAY_TRANSPORT_UNAVAILABLE: "OpenClaw Gateway 控制通道不可用，请检查认证配置。",
  OPENCLAW_VERSION_UNSUPPORTED: "OpenClaw 版本不受支持。",
  GATEWAY_RUN_ABORTED: "OpenClaw 中止了本次运行，请重试。",
  GATEWAY_RUN_FAILED: "OpenClaw 运行失败，请检查服务日志后重试。",
  GATEWAY_RUN_NOT_STARTED: "任务已被 OpenClaw 接受，但在等待期限内未观察到开始执行，请重试。",
  GATEWAY_ABORT_RELEASE_TIMEOUT: "已请求 OpenClaw 停止运行，但未能确认资源释放，请稍后再试。",
  RUN_ABORT_UNCONFIRMED: "已请求停止，但未能确认 OpenClaw 已释放运行资源，请稍后再试。",
  BRIDGE_WATCH_TIMEOUT: "运行可能仍在结束处理中，但面板未能及时确认最终状态，请稍后重试。",
  CONTEXT_BUDGET_EXCEEDED: "上下文预算不足，请压缩会话或减少输入后重试。",
  RUN_FAILED: "生成失败，请稍后重试。"
});

export function publicRunErrorMessage(code: string): string {
  return PUBLIC_RUN_ERROR_MESSAGES[code] ?? PUBLIC_RUN_ERROR_MESSAGES.RUN_FAILED!;
}

export function retainedRunErrorCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return Object.hasOwn(PUBLIC_RUN_ERROR_MESSAGES, code) ? code : "RUN_FAILED";
}
