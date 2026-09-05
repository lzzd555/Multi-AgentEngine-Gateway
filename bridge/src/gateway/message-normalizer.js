// bridge/src/gateway/message-normalizer.js
const PART_TYPES = new Set(["text", "tool", "step-finish"])

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
