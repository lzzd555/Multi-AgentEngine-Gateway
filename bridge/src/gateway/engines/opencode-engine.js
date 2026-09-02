// bridge/src/gateway/engines/opencode-engine.js
import { ManagedOpenCodeHost } from "../../opencode-host.js"
import { normalizeOpenCodeMessages } from "./normalize-opencode.js"

export const OPENCODE_CAPABILITIES = { questions: true, permissions: true, abort: true }

const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000
const SPEC_EVENT_TYPES = new Set([
  "session.status", "session.idle", "session.error", "message.part.updated",
  "question.asked", "permission.asked"
])

function splitModel(wireName) {
  if (typeof wireName !== "string" || !wireName.includes("/")) return undefined
  const separator = wireName.indexOf("/")
  return { providerID: wireName.slice(0, separator), modelID: wireName.slice(separator + 1) }
}

const engineUnavailable = (message) => Object.assign(new Error(message), { code: "ENGINE_UNAVAILABLE" })

export function createOpenCodeEngine({
  command = process.env.OPENCODE_COMMAND ?? "opencode",
  host = "127.0.0.1",
  upstreamPort = Number(process.env.GATEWAY_OPENCODE_PORT ?? 14096),
  username = "gateway",
  password = "gateway-local",
  manageHost = true,
  startTimeoutMs = 30_000,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS
} = {}) {
  const base = `http://${host}:${upstreamPort}`
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const listeners = new Set()
  // The `host` option names the upstream hostname; the spawned host instance lives here.
  // (A body-level `let host` would redeclare the parameter — a SyntaxError.)
  let managedHost
  let running = false

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // listener errors must not break the engine
      }
    }
  }

  async function request(path, init = {}) {
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: authorization, ...(init.headers ?? {}) }
      })
    } catch (error) {
      throw engineUnavailable(`OpenCode upstream unreachable: ${error.message}`)
    }
    if (response.status >= 500) throw engineUnavailable(`OpenCode upstream returned HTTP ${response.status}`)
    return response
  }

  async function requestJSON(path, init) {
    const response = await request(path, init)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }

  // The spec requires the list endpoints to answer 200 with an array; a real upstream may 404 with
  // a text body or return non-JSON, which must degrade to [] instead of surfacing a 500.
  async function listJSONOrEmpty(path) {
    try {
      const value = await requestJSON(path)
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  async function waitUntilIdle(sessionID) {
    const deadline = Date.now() + promptTimeoutMs
    // A freshly submitted turn is not marked busy instantly; polling before that moment must not
    // read as "turn over" (and a turn can even finish between two polls). Wait until busy was
    // observed at least once, or until the startup grace elapses — the grace must stay well below
    // the deadline so a never-busy turn still resolves instead of timing out.
    const startupGraceMs = Math.min(2_000, Math.floor(promptTimeoutMs / 2))
    const submittedAt = Date.now()
    let sawBusy = false
    while (Date.now() < deadline) {
      const statuses = await requestJSON("/session/status")
      if (statuses?.[sessionID]?.type === "busy") sawBusy = true
      else if (sawBusy || Date.now() - submittedAt >= startupGraceMs) return
      await sleepImpl(pollIntervalMs)
    }
    throw engineUnavailable(`OpenCode prompt timed out after ${promptTimeoutMs}ms`)
  }

  // Forward the upstream SSE stream to engine listeners, keeping only spec event types.
  async function pumpEventStream(signal) {
    while (running) {
      try {
        const response = await fetchImpl(`${base}/event`, { headers: { Authorization: authorization }, signal })
        if (!response.body) throw new Error("upstream SSE has no body")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data: "))
            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6))
                if (SPEC_EVENT_TYPES.has(event?.type)) emit({ type: event.type, properties: event.properties ?? {} })
              } catch {
                // a malformed upstream frame is dropped
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
        }
      } catch {
        // retry below while running
      }
      if (running) await sleepImpl(1_000)
    }
  }

  return {
    id: "opencode",
    label: "OpenCode",
    capabilities: OPENCODE_CAPABILITIES,

    async initialize() {
      running = true
      if (manageHost) {
        managedHost = new ManagedOpenCodeHost({ command, host, port: upstreamPort, username, password, startTimeoutMs })
        managedHost.on("unavailable", () => emit({ type: "session.error", properties: { error: { message: "OpenCode upstream exited" } } }))
        await managedHost.start()
      }
      void pumpEventStream(undefined)
    },

    async dispose() {
      running = false
      managedHost?.stop()
    },

    async createSession({ title, directory } = {}) {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
      const session = await requestJSON(`/session${query}`, {
        method: "POST",
        body: JSON.stringify({ title: title ?? "session" })
      })
      if (typeof session?.id !== "string") throw engineUnavailable("OpenCode createSession returned no id")
      return { id: session.id }
    },

    async deleteSession(sessionID) {
      await request(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    },

    async listSessionStatuses() {
      return (await requestJSON("/session/status")) ?? {}
    },

    async prompt(sessionID, { text, model } = {}) {
      const modelPart = splitModel(model)
      const response = await request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: text ?? "" }],
          ...(modelPart ? { model: modelPart } : {})
        })
      })
      if (response.status !== 204 && response.status !== 200) {
        throw engineUnavailable(`OpenCode prompt_async returned HTTP ${response.status}`)
      }
      await waitUntilIdle(sessionID)
    },

    async abort(sessionID) {
      const response = await request(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" })
      if (response.status === 404) {
        await request(`/session/${encodeURIComponent(sessionID)}/stop`, { method: "POST" })
      }
    },

    async listMessages(sessionID) {
      const messages = await requestJSON(`/session/${encodeURIComponent(sessionID)}/message`)
      return normalizeOpenCodeMessages(messages)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async listQuestions() {
      return listJSONOrEmpty("/question")
    },

    async replyQuestion(requestID, answers) {
      await request(`/question/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers })
      })
    },

    async listPermissions() {
      return listJSONOrEmpty("/permission")
    },

    async replyPermission(requestID, { reply, message } = {}) {
      await request(`/permission/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply, ...(message !== undefined ? { message } : {}) })
      })
    }
  }
}
