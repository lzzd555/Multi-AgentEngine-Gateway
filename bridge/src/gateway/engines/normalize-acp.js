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
 * OMP 把整回合的 text/tool 塞进同一条 assistant 消息；若整条输出后再展开工具结果，
 * 回合会以 tool 消息收尾，违反规范 §8.4"末条消息 role=assistant"。因此按 step 边界
 * （text 连续段 / tool 连续段交替）拆成多条消息：工具结果紧跟其请求段，最终文本段
 * （或补一条仅含 step-finish 的收尾消息）以 assistant(finish=stop) 收尾。
 */
function segmentParts(parts) {
  const segments = []
  for (const part of parts ?? []) {
    const kind = part?.type === "text" ? "text" : part?.type === "tool" ? "tool" : undefined
    if (!kind) continue // reasoning/file 不参与分段，也不打断连续段
    const last = segments.at(-1)
    if (last && last.kind === kind) last.parts.push(part)
    else segments.push({ kind, parts: [part] })
  }
  return segments
}

export function normalizeAcpMessages(messages, { busy = false } = []) {
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
    const segments = segmentParts(parts)
    // 无 text/tool part（如纯 reasoning 回合）：保持单消息形态，完成时仍带 step-finish
    if (segments.length === 0) {
      normalized.push({
        id: info.id,
        role: "assistant",
        content: "",
        created_at: createdAt,
        info: { role: "assistant", finish: busy && index === lastAssistantIndex ? "tool-calls" : "stop" },
        parts: [{ type: "step-finish" }]
      })
      return
    }
    const isLastAssistant = index === lastAssistantIndex
    segments.forEach((segment, segmentIndex) => {
      const id = segments.length === 1 ? info.id : `${info.id}:s${segmentIndex}`
      const isBusyTail = busy && isLastAssistant && segmentIndex === segments.length - 1
      if (segment.kind === "tool") {
        normalized.push({
          id,
          role: "assistant",
          content: "",
          tool_calls: segment.parts.map((part) => ({ id: part.callID ?? "", name: part.tool ?? "", arguments: part.state?.input ?? {} })),
          created_at: createdAt,
          info: { role: "assistant", finish: "tool-calls" },
          parts: [
            ...segment.parts.map((part) => ({ type: "tool", tool: part.tool, state: toolState(part.state) })),
            ...(isBusyTail ? [] : [{ type: "step-finish" }])
          ]
        })
        for (const part of segment.parts) {
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
      } else {
        normalized.push({
          id,
          role: "assistant",
          content: textOf(segment.parts),
          tool_calls: [],
          created_at: createdAt,
          info: { role: "assistant", finish: isBusyTail ? "tool-calls" : "stop" },
          parts: [
            ...segment.parts.map((part) => ({ type: "text", content: part.text ?? "" })),
            ...(isBusyTail ? [] : [{ type: "step-finish" }])
          ]
        })
      }
    })
    // 完成的回合若以工具段收尾（OMP 常见：工具全部跑完但无总结文本），补一条仅含
    // step-finish 的 assistant 收尾消息，保证 §8.4 的末条消息形态
    if (!(busy && isLastAssistant) && segments.at(-1).kind === "tool") {
      normalized.push({
        id: `${info.id}:close`,
        role: "assistant",
        content: "",
        created_at: createdAt,
        info: { role: "assistant", finish: "stop" },
        parts: [{ type: "step-finish" }]
      })
    }
  })
  return normalized
}
