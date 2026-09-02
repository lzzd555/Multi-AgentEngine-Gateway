// bridge/src/gateway/message-normalizer.js
const PART_TYPES = new Set(["text", "tool", "step-finish"])
const ROLES = new Set(["user", "assistant", "tool"])

/** Keep only spec part types with spec field names; everything else is dropped. */
export function normalizePart(part) {
  if (!part || typeof part !== "object" || !PART_TYPES.has(part.type)) return undefined
  if (part.type === "text") {
    return typeof part.content === "string" ? { type: "text", content: part.content } : undefined
  }
  if (part.type === "tool") {
    if (typeof part.tool !== "string") return undefined
    const state = part.state && typeof part.state === "object"
      ? { status: part.state.status, ...(part.state.title !== undefined ? { title: part.state.title } : {}) }
      : {}
    return { type: "tool", tool: part.tool, state }
  }
  return { type: "step-finish" }
}

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
