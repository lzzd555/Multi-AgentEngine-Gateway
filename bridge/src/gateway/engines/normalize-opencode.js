// bridge/src/gateway/engines/normalize-opencode.js
import { normalizePart } from "../message-normalizer.js"

const OUTPUT_LIMIT = 2_000
const ROLES = ["user", "assistant", "tool"]

function fallbackTimestamp() {
  return new Date().toISOString()
}

function clip(value) {
  if (typeof value === "string") return value.slice(0, OUTPUT_LIMIT)
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value).slice(0, OUTPUT_LIMIT)
  } catch {
    return ""
  }
}

/**
 * opencode 1.x actually serves each message as an {info, parts} envelope — the spec's flat
 * {id, role, content} shape is our gateway's own presentation, not the upstream wire format.
 * Map the real envelope onto the spec shape; drop anything without a usable identity.
 */
function fromOpenCodeEnvelope(message) {
  if (!message || typeof message !== "object") return undefined
  const info = message.info ?? {}
  if (typeof info.id !== "string" || !ROLES.includes(info.role)) return undefined
  const createdAt = info.time?.created ? new Date(info.time.created).toISOString() : fallbackTimestamp()
  const parts = Array.isArray(message.parts) ? message.parts : []
  const content = parts
    .filter((part) => part?.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
  if (info.role === "user") {
    return { id: info.id, role: "user", content, created_at: createdAt }
  }
  if (info.role === "tool") {
    return {
      id: info.id,
      role: "tool",
      content,
      tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
      tool_name: typeof message.tool_name === "string" ? message.tool_name : "",
      created_at: createdAt
    }
  }

  const toolParts = parts.filter((part) => part?.type === "tool")
  const normalizedParts = parts.map(normalizeOpenCodePart).filter(Boolean)
  const finish = info.time?.completed ? "stop" : "tool-calls"
  if (finish === "stop" && !normalizedParts.some((part) => part.type === "step-finish")) {
    // The judge's completion rule requires a step-finish on the finished message; opencode
    // versions that omit the native step-finish part still mark completion via time.completed.
    normalizedParts.push({ type: "step-finish" })
  }
  const normalized = {
    id: info.id,
    role: "assistant",
    content,
    tool_calls: toolParts.map((part, index) => ({
      id: part.callID ?? part.state?.id ?? `call_${index}`,
      name: typeof part.tool === "string" ? part.tool : "",
      arguments: part.state?.input ?? {}
    })),
    created_at: createdAt,
    info: { role: "assistant", finish },
    parts: normalizedParts
  }
  const output = [normalized]
  for (const part of toolParts) {
    if (!["completed", "error"].includes(part.state?.status)) continue
    output.push({
      id: `${part.callID ?? part.state?.id ?? "tool"}:result`,
      role: "tool",
      tool_call_id: part.callID ?? part.state?.id ?? "",
      tool_name: typeof part.tool === "string" ? part.tool : "",
      content: clip(part.state?.output),
      created_at: createdAt
    })
  }
  return output
}

function normalizeOpenCodePart(part) {
  if (part?.type === "text") {
    return typeof part.text === "string" ? { type: "text", content: part.text } : undefined
  }
  if (part?.type === "tool") {
    if (typeof part.tool !== "string") return undefined
    const state = part.state && typeof part.state === "object"
      ? { status: part.state.status, ...(part.state.title !== undefined ? { title: part.state.title } : {}) }
      : {}
    return { type: "tool", tool: part.tool, state }
  }
  if (part?.type === "step-finish") return { type: "step-finish" }
  return undefined
}

function fromSpecShape(message) {
  if (!message || typeof message !== "object" || typeof message.id !== "string") return undefined
  if (!ROLES.includes(message.role)) return undefined
  const normalized = {
    id: message.id,
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    created_at: typeof message.created_at === "string" ? message.created_at : fallbackTimestamp()
  }
  if (message.role === "assistant") {
    normalized.tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    normalized.info = {
      role: "assistant",
      finish: message.info?.finish === "tool-calls" ? "tool-calls" : "stop"
    }
    normalized.parts = (Array.isArray(message.parts) ? message.parts : [])
      .map(normalizePart)
      .filter(Boolean)
  }
  if (message.role === "tool") {
    normalized.tool_call_id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
    normalized.tool_name = typeof message.tool_name === "string" ? message.tool_name : ""
  }
  return normalized
}

/**
 * Accept both dialects: the real opencode wire envelope ({info, parts}) and the spec's flat
 * shape (which our test fake and the interface doc use). Returns a flat normalized list.
 */
export function normalizeOpenCodeMessages(messages) {
  if (!Array.isArray(messages)) return []
  // The spec's flat shape always carries a top-level string id (alongside optional info/parts);
  // the real opencode envelope never does — its identity lives in info.id. Disambiguate on that.
  return messages
    .map((message) => (typeof message?.id === "string" ? fromSpecShape(message) : fromOpenCodeEnvelope(message)))
    .flat()
    .filter(Boolean)
}
