import { createReadStream } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const BACKWARD_READ_BYTES = 64 * 1024
const MODEL_CONTEXT_LOOKBACK_BYTES = 4 * 1024 * 1024

function trimCarriageReturn(buffer) {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, -1) : buffer
}

function recordFromLine(line) {
  try {
    return JSON.parse(trimCarriageReturn(line).toString("utf8"))
  } catch {
    return undefined
  }
}

function messageFromRecord(sessionID, record, offset) {
  if (record?.type !== "event_msg") return undefined
  const payload = record.payload
  const role = payload?.type === "user_message" ? "user"
    : payload?.type === "agent_message" || payload?.type === "agent_reasoning" ? "assistant"
    : undefined
  if (!role) return undefined

  const type = payload.type === "agent_reasoning" ? "reasoning" : "text"
  const text = payload.type === "agent_reasoning" ? payload.text : payload.message
  if (typeof text !== "string" || !text) return undefined

  // Rollouts are append-only. A byte offset is therefore both unique inside the file and stable as
  // later turns are appended. The paged tail reader can derive it without first scanning all older
  // lines, unlike the old ordinal-based id.
  const messageID = `${sessionID}:byte:${offset}`
  const created = Date.parse(record.timestamp ?? "")
  return {
    info: {
      id: messageID,
      role,
      sessionID,
      time: { created: Number.isFinite(created) ? created : Date.now() }
    },
    parts: [{ id: `${messageID}:${type}:0`, messageID, type, text }]
  }
}

function messageFromLine(sessionID, line, offset) {
  return messageFromRecord(sessionID, recordFromLine(line), offset)
}

/**
 * Codex persists the model and reasoning effort that own a turn in `turn_context`. Reading that
 * record is lock-free, unlike ACP session/load, and is the same native rollout authority used for
 * transcript recovery. The app presents Codex's bare model ids under the synthetic `codex` provider,
 * matching the ACP catalog's fallback provider id.
 */
function modelFromTurnContext(record) {
  if (record?.type !== "turn_context") return undefined
  const modelID = typeof record.payload?.model === "string" ? record.payload.model.trim() : ""
  if (!modelID) return undefined
  const effortValue = record.payload?.effort ?? record.payload?.collaboration_mode?.reasoning_effort
  const variant = typeof effortValue === "string" && effortValue.trim() ? effortValue.trim() : undefined
  return { providerID: "codex", modelID, ...(variant ? { variant } : {}) }
}

async function* forwardLines(file) {
  let pending = Buffer.alloc(0)
  let pendingStart = 0
  for await (const chunk of createReadStream(file)) {
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue
      yield { line: data.subarray(lineStart, index), offset: pendingStart + lineStart }
      lineStart = index + 1
    }
    pending = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : Buffer.alloc(0)
    pendingStart += lineStart
  }
  if (pending.length > 0) yield { line: pending, offset: pendingStart }
}

async function readCodexPage(file, sessionID, { limit = 100, before } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const handle = await open(file, "r")
  try {
    const { size } = await handle.stat()
    let end = size
    if (before !== undefined && before !== null && before !== "") {
      const parsed = Number(before)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > size) {
        throw new Error("Invalid Codex history cursor")
      }
      end = parsed
    }

    const found = []
    let currentModel
    let cursor = end
    let carry = Buffer.alloc(0)
    const modelSearchFloor = Math.max(0, end - MODEL_CONTEXT_LOOKBACK_BYTES)
    const needMore = () => found.length <= boundedLimit
      || (!before && !currentModel && cursor > modelSearchFloor)

    while (cursor > 0 && needMore()) {
      const start = Math.max(0, cursor - BACKWARD_READ_BYTES)
      const chunk = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length > 0
        ? Buffer.concat([chunk.subarray(0, bytesRead), carry])
        : chunk.subarray(0, bytesRead)

      let lineEnd = data.length
      for (let index = data.length - 1; index >= 0 && (found.length <= boundedLimit || (!before && !currentModel)); index -= 1) {
        if (data[index] !== 0x0a) continue
        const lineStart = index + 1
        if (lineStart < lineEnd) {
          const offset = start + lineStart
          const record = recordFromLine(data.subarray(lineStart, lineEnd))
          // Only the newest-page read describes the Session's current model. Older page requests
          // deliberately omit model metadata so paging cannot rewind the picker to a historical turn.
          if (!before && !currentModel) currentModel = modelFromTurnContext(record)
          if (found.length <= boundedLimit) {
            const message = messageFromRecord(sessionID, record, offset)
            if (message) found.push({ message, offset })
          }
        }
        lineEnd = index
      }

      if (start === 0) {
        if (lineEnd > 0 && (found.length <= boundedLimit || (!before && !currentModel))) {
          const record = recordFromLine(data.subarray(0, lineEnd))
          if (!before && !currentModel) currentModel = modelFromTurnContext(record)
          if (found.length <= boundedLimit) {
            const message = messageFromRecord(sessionID, record, 0)
            if (message) found.push({ message, offset: 0 })
          }
        }
        carry = Buffer.alloc(0)
        cursor = 0
      } else {
        carry = lineEnd > 0 ? Buffer.from(data.subarray(0, lineEnd)) : Buffer.alloc(0)
        cursor = start
      }
    }

    const hasMore = found.length > boundedLimit
    const newest = found.slice(0, boundedLimit)
    const messages = newest.map((entry) => entry.message).reverse()
    const nextBefore = hasMore && newest.length > 0 ? String(newest[newest.length - 1].offset) : null
    return {
      messages,
      before: nextBefore,
      hasMore,
      ...(currentModel ? { model: currentModel } : {})
    }
  } finally {
    await handle.close()
  }
}

/**
 * Codex allows a single writer per thread and takes the lock for the whole time a client holds the
 * thread open, so `session/load` answers "thread <id> already has an active writer" for every
 * session the Codex desktop app or a `codex` CLI is sitting on, which is precisely the sessions a
 * user wants to look at from their phone. Reading the rollout the harness already wrote takes no
 * lock, so those sessions can be shown even while Codex itself owns them.
 *
 * The transcript comes from the `event_msg` records rather than the `response_item` ones: only the
 * former carry what the user actually saw. The latter also hold the instruction blocks Codex feeds
 * the model, AGENTS.md, the plugin list and desktop app context, under the `user` role, which would
 * surface as the user's own turns.
 */
export function createCodexHistoryLoader(sessionRoot = path.join(homedir(), ".codex", "sessions")) {
  const sessionFiles = new Map()

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
    try {
      // Rollouts are filed under sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl.
      const suffix = `-${sessionID}.jsonl`
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith(suffix))
      if (!entry) return undefined
      const file = path.join(entry.parentPath ?? entry.path, entry.name)
      sessionFiles.set(sessionID, file)
      return file
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  const loadCodexHistory = async function loadCodexHistory(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const messages = []
    for await (const { line, offset } of forwardLines(file)) {
      const message = messageFromLine(sessionID, line, offset)
      if (message) messages.push(message)
    }
    return messages
  }

  loadCodexHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return { messages: [], before: null, hasMore: false }
    return readCodexPage(file, sessionID, options)
  }

  return loadCodexHistory
}
