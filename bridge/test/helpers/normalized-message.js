// bridge/test/helpers/normalized-message.js
// 规范消息结构判分器（测试 oracle）：生产模块只保留被网关使用的 normalizePart，
// 校验逻辑属于测试侧，集中在此供 spec-conformance 与 normalize 测试共用。
const ROLES = new Set(["user", "assistant", "tool"])

/** Structural check used by the spec-conformance suite. */
export function isValidNormalizedMessage(message) {
  if (!message || typeof message !== "object") return false
  if (typeof message.id !== "string" || !ROLES.has(message.role)) return false
  if (typeof message.content !== "string") return false
  if (typeof message.created_at !== "string") return false
  if (message.role === "assistant") {
    if (!message.info || message.info.role !== "assistant") return false
    if (!["stop", "tool-calls"].includes(message.info.finish)) return false
    if (!Array.isArray(message.parts)) return false
    if (!message.parts.some((part) => part?.type === "step-finish")) return false
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) return false
  }
  if (message.role === "tool" && (typeof message.tool_call_id !== "string" || typeof message.tool_name !== "string")) return false
  return true
}
