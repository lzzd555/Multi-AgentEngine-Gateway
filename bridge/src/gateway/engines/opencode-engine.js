// bridge/src/gateway/engines/opencode-engine.js
import path from "node:path"
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
  args = [],
  env = {},
  host = "127.0.0.1",
  upstreamPort = Number(process.env.GATEWAY_OPENCODE_PORT ?? 14096),
  username = "gateway",
  password = "gateway-local",
  manageHost = true,
  startTimeoutMs = 30_000,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
  spawnProcess,
  waitUntilReady
} = {}) {
  const base = `http://${host}:${upstreamPort}`
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const listeners = new Set()
  // The `host` option names the upstream hostname; the spawned host instance lives here.
  // (A body-level `let host` would redeclare the parameter — a SyntaxError.)
  let managedHost
  let running = false
  // 通用规范 1.2：会话可绑定目录；sessionDirectories 记住绑定关系以便后续请求续带 ?directory=，
  // directoryStreams 为每个目录维护一条 SSE 订阅（目录会话的事件只出现在对应目录流上）。
  const sessionDirectories = new Map()
  const directoryStreams = new Map()
  // 反问/授权请求 id → 来源目录。应答必须打到来源实例：无作用域 reply 会落到错误实例，
  // 挂起的回合永不恢复（实测 200 但不解除挂起，带目录 18.3s 正常完成）。
  const requestDirectories = new Map()

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

  // 通用规范 1.2：目录作用域会话的反问/授权只出现在 ?directory= 作用域列表上（实测确认），
  // 无作用域列表恒为空；评测按规范 §8.2 轮询无作用域列表，不聚合则永远看不到反问。
  // 逐目录补拉作用域视图后按 id 合并：无作用域条目在前、作用域独有条目追加，同 id 时作用域值优先
  //（与 listSessionStatuses 的合并策略同源，只是形状为数组）。作用域拉取失败按 listJSONOrEmpty 降级为 []。
  // （listSessionStatuses 保持独立实现：其合并形状是对象按会话 id Object.assign，且不降级。）
  async function listScopedOrEmpty(path) {
    const merged = [...(await listJSONOrEmpty(path))]
    for (const directory of new Set(sessionDirectories.values())) {
      const scoped = await listJSONOrEmpty(`${path}?directory=${encodeURIComponent(directory)}`)
      for (const entry of scoped) {
        // 记录作用域条目的来源目录（供 replyQuestion/replyPermission 续带）；无作用域条目
        // 不携带目录信息，跳过——不得用 undefined 覆盖已记录的映射。
        if (typeof entry?.id === "string") requestDirectories.set(entry.id, directory)
        const existing = typeof entry?.id === "string" ? merged.findIndex((item) => item?.id === entry.id) : -1
        if (existing === -1) merged.push(entry)
        else merged[existing] = entry
      }
    }
    return merged
  }

  async function waitUntilIdle(sessionID, timeoutMs = promptTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    // A freshly submitted turn is not marked busy instantly; polling before that moment must not
    // read as "turn over" (and a turn can even finish between two polls). Wait until busy was
    // observed at least once, or until the startup grace elapses — the grace must stay well below
    // the deadline so a never-busy turn still resolves instead of timing out.
    const startupGraceMs = Math.min(2_000, Math.floor(timeoutMs / 2))
    const submittedAt = Date.now()
    let sawBusy = false
    while (Date.now() < deadline) {
      const statuses = await requestJSON(statusPath(sessionID))
      if (statuses?.[sessionID]?.type === "busy") sawBusy = true
      else if (sawBusy || Date.now() - submittedAt >= startupGraceMs) return
      await sleepImpl(pollIntervalMs)
    }
    // promptTimeout 标记是引擎层重试的识别依据（prompt-retry.js 只重试带此标记的超时）。
    throw Object.assign(engineUnavailable(`OpenCode prompt timed out after ${timeoutMs}ms`), { promptTimeout: true })
  }

  // Forward the upstream SSE stream to engine listeners, keeping only spec event types.
  async function pumpEventStream(signal, eventPath = "/event") {
    while (running) {
      try {
        const response = await fetchImpl(`${base}${eventPath}`, { headers: { Authorization: authorization }, signal })
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

  // 通用规范 1.2：目录作用域会话的事件只出现在 /event?directory=<dir> 流上（实测确认），
  // 默认无作用域流收不到；因此每个目录首会话补一条订阅，事件并入同一 emit 分发。
  function ensureDirectoryStream(directory) {
    if (directoryStreams.has(directory)) return
    const controller = new AbortController()
    directoryStreams.set(directory, controller)
    void pumpEventStream(controller.signal, `/event?directory=${encodeURIComponent(directory)}`)
  }

  function scopedPath(sessionID, suffix) {
    const directory = sessionDirectories.get(sessionID)
    const base = `/session/${encodeURIComponent(sessionID)}${suffix}`
    return directory ? `${base}?directory=${encodeURIComponent(directory)}` : base
  }

  // 与 scopedPath 同构但按反问/授权请求 id 取来源目录；未记录来源的 id 保持无 query 的旧路径。
  function requestScopeQuery(requestID) {
    const directory = requestDirectories.get(requestID)
    return directory ? `?directory=${encodeURIComponent(directory)}` : ""
  }

  // 通用规范 1.2：目录作用域会话的 busy 态只出现在 /session/status?directory= 上（实测确认），
  // 无作用域状态恒为 idle，轮询它会把进行中的回合误判为已结束。
  function statusPath(sessionID) {
    const directory = sessionDirectories.get(sessionID)
    return directory ? `/session/status?directory=${encodeURIComponent(directory)}` : "/session/status"
  }

  return {
    id: "opencode",
    label: "OpenCode",
    capabilities: OPENCODE_CAPABILITIES,

    async initialize() {
      running = true
      if (manageHost) {
        managedHost = new ManagedOpenCodeHost({
          command, host, port: upstreamPort, username, password, startTimeoutMs,
          environment: { ...process.env, ...env },
          extraArgs: args,
          ...(spawnProcess ? { spawnProcess } : {}),
          ...(waitUntilReady ? { waitUntilReady } : {})
        })
        managedHost.on("unavailable", () => emit({ type: "session.error", properties: { error: { message: "OpenCode upstream exited" } } }))
        await managedHost.start()
      }
      void pumpEventStream(undefined)
    },

    async dispose() {
      running = false
      for (const controller of directoryStreams.values()) controller.abort()
      directoryStreams.clear()
      managedHost?.stop()
    },

    async createSession({ title, directory } = {}) {
      const normalized = typeof directory === "string" && directory.trim() ? path.resolve(directory) : undefined
      const query = normalized ? `?directory=${encodeURIComponent(normalized)}` : ""
      const session = await requestJSON(`/session${query}`, {
        method: "POST",
        body: JSON.stringify({ title: title ?? "session" })
      })
      if (typeof session?.id !== "string") throw engineUnavailable("OpenCode createSession returned no id")
      if (normalized) {
        sessionDirectories.set(session.id, normalized)
        ensureDirectoryStream(normalized)
      }
      return { id: session.id }
    },

    async deleteSession(sessionID) {
      await request(scopedPath(sessionID, ""), { method: "DELETE" })
      sessionDirectories.delete(sessionID)
    },

    async listSessionStatuses() {
      // 通用规范 1.2：无作用域状态会把目录作用域会话误报为 idle，因此逐目录补拉作用域视图，
      // 按会话合并且作用域值优先（它才是这些会话的权威状态）。
      const merged = (await requestJSON("/session/status")) ?? {}
      for (const directory of new Set(sessionDirectories.values())) {
        const scoped = await requestJSON(`/session/status?directory=${encodeURIComponent(directory)}`)
        if (scoped) Object.assign(merged, scoped)
      }
      return merged
    },

    async prompt(sessionID, { text, model, timeoutMs } = {}) {
      const modelPart = splitModel(model)
      const response = await request(scopedPath(sessionID, "/prompt_async"), {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: text ?? "" }],
          ...(modelPart ? { model: modelPart } : {})
        })
      })
      if (response.status !== 204 && response.status !== 200) {
        throw engineUnavailable(`OpenCode prompt_async returned HTTP ${response.status}`)
      }
      // 调用级 timeoutMs（引擎层重试每轮倍增后下发）覆盖构造期默认；缺省保持原行为。
      await waitUntilIdle(sessionID, timeoutMs)
    },

    async abort(sessionID) {
      const response = await request(scopedPath(sessionID, "/abort"), { method: "POST" })
      if (response.status === 404) {
        await request(scopedPath(sessionID, "/stop"), { method: "POST" })
      }
    },

    async listMessages(sessionID) {
      const messages = await requestJSON(scopedPath(sessionID, "/message"))
      return normalizeOpenCodeMessages(messages)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async listQuestions() {
      return listScopedOrEmpty("/question")
    },

    async replyQuestion(requestID, answers) {
      await request(`/question/${encodeURIComponent(requestID)}/reply${requestScopeQuery(requestID)}`, {
        method: "POST",
        body: JSON.stringify({ answers })
      })
    },

    async listPermissions() {
      return listScopedOrEmpty("/permission")
    },

    async replyPermission(requestID, { reply, message } = {}) {
      await request(`/permission/${encodeURIComponent(requestID)}/reply${requestScopeQuery(requestID)}`, {
        method: "POST",
        body: JSON.stringify({ reply, ...(message !== undefined ? { message } : {}) })
      })
    }
  }
}
