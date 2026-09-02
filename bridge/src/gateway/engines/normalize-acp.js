// bridge/src/gateway/engines/normalize-acp.js
const OUTPUT_LIMIT = 2_000

export function acpStatusToSpec(status) {
  if (status === "completed") return "completed"
  if (status === "error" || status === "incomplete") return "error"
  return "running" // pending, running, unknown
}

function textOf(parts) {
  return (parts ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
}

function toolState(state) {
  return {
    status: acpStatusToSpec(state?.status),
    ...(state?.title !== undefined ? { title: state.title } : {})
  }
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
 * Step boundary: a tool part after text ends a step, and text after tools ends the tool batch.
 * A trailing step-finish is only appended when the turn is over (the session is not busy), and it
 * is appended even when no text/tool part preceded it (reasoning/file-only tail), so a completed
 * message always carries a step-finish.
 */
function assistantParts(parts, { busy }) {
  const output = []
  let previousKind = undefined
  for (const part of parts ?? []) {
    if (part?.type === "text") {
      if (previousKind === "tool") output.push({ type: "step-finish" })
      output.push({ type: "text", content: part.text ?? "" })
      previousKind = "text"
    } else if (part?.type === "tool") {
      if (previousKind === "text") output.push({ type: "step-finish" })
      output.push({ type: "tool", tool: part.tool, state: toolState(part.state) })
      previousKind = "tool"
    }
    // reasoning and file parts are not part of the spec vocabulary
  }
  if (!busy) output.push({ type: "step-finish" })
  return output
}

export function normalizeAcpMessages(messages, { busy = false } = {}) {
  if (!Array.isArray(messages)) return []
  const normalized = []
  const lastAssistantIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === "assistant") return index
    }
    return -1
  })()

  messages.forEach((message, index) => {
    const info = message?.info
    if (!info || typeof info.id !== "string") return
    const createdAt = new Date(info.time?.created ?? Date.now()).toISOString()
    if (info.role === "user") {
      normalized.push({ id: info.id, role: "user", content: textOf(message.parts), created_at: createdAt })
      return
    }
    if (info.role !== "assistant") return

    const parts = message.parts ?? []
    // An assistant message that carries only a turn error produced no LLM output; presenting it
    // as finish=stop + step-finish would fake the judge's completion signal for a failed turn.
    if (info.error && !parts.some((part) => (part.type === "text" && part.text?.trim()) || part.type === "tool")) {
      normalized.push({
        id: info.id,
        role: "assistant",
        content: "",
        created_at: createdAt,
        info: { role: "assistant", finish: "error" },
        parts: [],
        ...(info.error?.message ? { error: info.error.message } : {})
      })
      return
    }
    const isBusyTail = busy && index === lastAssistantIndex
    normalized.push({
      id: info.id,
      role: "assistant",
      content: textOf(parts),
      tool_calls: parts
        .filter((part) => part?.type === "tool")
        .map((part) => ({ id: part.callID ?? "", name: part.tool ?? "", arguments: part.state?.input ?? {} })),
      created_at: createdAt,
      info: { role: "assistant", finish: isBusyTail ? "tool-calls" : "stop" },
      parts: assistantParts(parts, { busy: isBusyTail })
    })

    for (const part of parts) {
      if (part?.type !== "tool") continue
      if (part.state?.status !== "completed" && part.state?.status !== "error" && part.state?.status !== "incomplete") continue
      normalized.push({
        id: `${part.callID ?? "tool"}:result`,
        role: "tool",
        tool_call_id: part.callID ?? "",
        tool_name: part.tool ?? "",
        content: clip(part.state?.output),
        created_at: createdAt
      })
    }
  })
  return normalized
}
