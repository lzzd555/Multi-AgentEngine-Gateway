// bridge/src/gateway/gateway-server.js
import { createServer } from "node:http"

function writeJSON(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}

function sendError(response, status, code, message) {
  writeJSON(response, status, { code, message })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error("request body is not valid JSON"), { statusCode: 400 }))
      }
    })
    request.on("error", reject)
  })
}

/** Engine failures map onto the spec's error table; ENGINE_UNAVAILABLE is a 502. */
function engineErrorResponse(error) {
  if (error?.code === "ENGINE_UNAVAILABLE") return [502, "BAD_GATEWAY", error.message]
  return [500, "INTERNAL_ERROR", error?.message ?? "internal error"]
}

export function createGatewayServer({
  engine,
  eventBus,
  registry,
  interactionQueue,
  defaultModel = "zai/glm-5.2"
}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://gateway")
      const path = url.pathname
      const method = request.method

      if (method === "GET" && path === "/event") return eventBus.handle(request, response)
      if (method === "GET" && path === "/health") return writeJSON(response, 200, { ok: true })

      if (method === "POST" && path === "/session") {
        const body = await readBody(request)
        // 通用规范 1.2：title 可选（缺省自动生成）；directory 在 body（query 为兼容回落）
        const rawTitle = typeof body.title === "string" ? body.title.trim() : ""
        const title = rawTitle || `会话-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14).replace(/^(\d{8})(\d{6})$/, "$1-$2")}`
        const bodyDirectory = typeof body.directory === "string" && body.directory.trim() ? body.directory : undefined
        const directory = bodyDirectory ?? url.searchParams.get("directory") ?? undefined
        const { id } = await engine.createSession({ title, directory })
        const record = registry.register({ id, title })
        return writeJSON(response, 200, record)
      }

      if (method === "GET" && path === "/session/status") {
        return writeJSON(response, 200, registry.statuses())
      }

      if (method === "GET" && path === "/question") {
        if (!engine.capabilities.questions) return writeJSON(response, 200, [])
        return writeJSON(response, 200, await engine.listQuestions())
      }
      const questionReply = path.match(/^\/question\/([^/]+)\/reply$/)
      if (questionReply && method === "POST") {
        const body = await readBody(request)
        if (!Array.isArray(body.answers)) return sendError(response, 400, "VALIDATION_ERROR", "answers is required")
        if (engine.capabilities.questions) await engine.replyQuestion(decodeURIComponent(questionReply[1]), body.answers)
        else if (!interactionQueue.resolveQuestion(decodeURIComponent(questionReply[1]), body.answers)) {
          return sendError(response, 404, "NOT_FOUND", "Question not found")
        }
        return writeJSON(response, 200, { ok: true })
      }
      if (method === "GET" && path === "/permission") {
        const queued = interactionQueue.listPermissions()
        if (queued.length || !engine.capabilities.permissions) return writeJSON(response, 200, queued)
        return writeJSON(response, 200, await engine.listPermissions())
      }
      const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/)
      if (permissionReply && method === "POST") {
        const body = await readBody(request)
        if (!["once", "always", "reject"].includes(body.reply)) {
          return sendError(response, 400, "VALIDATION_ERROR", "reply must be once, always or reject")
        }
        const requestID = decodeURIComponent(permissionReply[1])
        if (interactionQueue.resolvePermission(requestID, body)) {
          return writeJSON(response, 200, { ok: true })
        }
        if (engine.capabilities.permissions) {
          await engine.replyPermission(requestID, body)
          return writeJSON(response, 200, { ok: true })
        }
        return sendError(response, 404, "NOT_FOUND", "Permission request not found")
      }

      const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(message|prompt_async|abort|stop|todo))?$/)
      if (!sessionMatch) return sendError(response, 404, "NOT_FOUND", "Not found")
      const sessionID = decodeURIComponent(sessionMatch[1])
      const action = sessionMatch[2]

      if (!action && method === "GET") {
        const record = registry.get(sessionID)
        if (!record) return sendError(response, 404, "NOT_FOUND", "Session not found")
        const messages = await engine.listMessages(sessionID)
        return writeJSON(response, 200, { ...record, message_count: messages.length })
      }

      if (!action && method === "DELETE") {
        if (!registry.has(sessionID)) return sendError(response, 404, "NOT_FOUND", "Session not found")
        await engine.deleteSession(sessionID)
        registry.remove(sessionID)
        return writeJSON(response, 200, { ok: true })
      }

      if (action) {
        const handled = await handleSessionAction({ request, response, sessionID, action, engine, registry, eventBus, defaultModel })
        if (handled) return
      }
      return sendError(response, 404, "NOT_FOUND", "Not found")
    } catch (error) {
      if (error?.statusCode === 400) return sendError(response, 400, "VALIDATION_ERROR", error.message)
      const [status, code, message] = engineErrorResponse(error)
      return sendError(response, status, code, message)
    }
  })

  // Engines that surface questions/permissions register them here; the routes above read the queue.
  function askQuestion(record) {
    const entry = interactionQueue.addQuestion(record.sessionID, record.questions)
    eventBus.emit({ type: "question.asked", properties: { sessionID: record.sessionID, id: entry.id, questions: record.questions } })
    return entry
  }
  function askPermission(record) {
    const entry = interactionQueue.addPermission(record.sessionID, record.permission, record.patterns)
    eventBus.emit({ type: "permission.asked", properties: { sessionID: record.sessionID, id: entry.id, permission: record.permission, patterns: record.patterns } })
    return entry
  }
  return { server, askQuestion, askPermission }
}

async function handleSessionAction({ request, response, sessionID, action, engine, registry, eventBus, defaultModel }) {
  const method = request.method
  if (!registry.has(sessionID)) {
    sendError(response, 404, "NOT_FOUND", "Session not found")
    return true
  }

  if (action === "message" && method === "GET") {
    writeJSON(response, 200, await engine.listMessages(sessionID))
    return true
  }

  if (action === "prompt_async" && method === "POST") {
    const body = await readBody(request)
    const text = (Array.isArray(body.parts) ? body.parts : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (!body.parts || !text) {
      sendError(response, 400, "VALIDATION_ERROR", "parts with a text entry are required")
      return true
    }
    const model = body.model?.providerID && body.model?.modelID
      ? `${body.model.providerID}/${body.model.modelID}`
      : defaultModel
    registry.setStatus(sessionID, "busy")
    eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    try {
      await engine.prompt(sessionID, { text, model })
    } finally {
      // Order matters: the engine's final message must already be readable when idle is signaled.
      registry.setStatus(sessionID, "idle")
      eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
      eventBus.emit({ type: "session.idle", properties: { sessionID } })
    }
    response.writeHead(204)
    response.end()
    return true
  }

  if ((action === "abort" || action === "stop") && method === "POST") {
    await engine.abort(sessionID)
    registry.setStatus(sessionID, "idle")
    eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    writeJSON(response, 200, { ok: true })
    return true
  }

  return false
}
