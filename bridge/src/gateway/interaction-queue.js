// bridge/src/gateway/interaction-queue.js
import { randomUUID } from "node:crypto"

export function createInteractionQueue({ now = () => new Date().toISOString() } = {}) {
  const entries = new Map()

  function add(kind, sessionID, payload) {
    const id = `req_${randomUUID().slice(0, 8)}`
    let resolveSettled
    const settled = new Promise((resolve) => { resolveSettled = resolve })
    entries.set(id, {
      kind,
      done: false,
      record: { id, sessionID, ...payload, created_at: now() },
      resolveSettled
    })
    return { id, settled }
  }

  function list(kind) {
    return [...entries.values()].filter((entry) => entry.kind === kind && !entry.done).map((entry) => entry.record)
  }

  function resolveEntry(id, answer) {
    const entry = entries.get(id)
    if (!entry || entry.done) return false
    entry.done = true
    entry.resolveSettled(answer)
    return true
  }

  return {
    addQuestion(sessionID, questions) {
      return add("question", sessionID, { questions })
    },
    addPermission(sessionID, permission, patterns) {
      return add("permission", sessionID, { permission, patterns })
    },
    listQuestions() {
      return list("question")
    },
    listPermissions() {
      return list("permission")
    },
    resolveQuestion(id, answers) {
      return resolveEntry(id, { answers })
    },
    resolvePermission(id, { reply, message } = {}) {
      return resolveEntry(id, { reply, message })
    }
  }
}
