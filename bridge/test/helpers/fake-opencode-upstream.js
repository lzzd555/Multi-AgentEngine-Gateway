// bridge/test/helpers/fake-opencode-upstream.js
// A fake upstream that mimics the opencode server API the gateway engine proxies. Extracted from
// the Task 7 engine test so the spec-conformance suite can reuse it.
//
// `streamEvents` (default false) adds GET /event as a Server-Sent-Events endpoint: every prompt
// pushes one `message.part.updated` frame, which the opencode engine forwards as a spec event.
// It is opt-in because an open SSE response changes how undici schedules the engine's other
// requests to the same origin (the response headers must be flushed immediately, and requests
// interleave differently), which would break the strict still-busy timing the Task 7 test asserts.
// Prompts block exactly as Task 7 requires either way: the session stays busy until the test pops
// an armed resolver from `state.promptResolvers`.
import { createServer } from "node:http"

export async function createFakeOpencodeUpstream({ streamEvents = false, delayedBusyMs = 0 } = {}) {
  const state = {
    sessions: new Map(),
    busy: new Set(),
    messages: new Map(),
    promptResolvers: [],
    directories: [],
    partEvents: [],
    // GET paths that answer 404 with a plain-text body (real-upstream shapes the lists must tolerate).
    textNotFoundPaths: new Set()
  }
  const sseResponses = new Set()

  function broadcast(event) {
    state.partEvents.push(event)
    for (const response of sseResponses) response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://upstream")
    const send = (body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(body === undefined ? "" : JSON.stringify(body))
    }
    if (request.method === "GET" && url.pathname === "/event") {
      if (!streamEvents) return send({}, 404)
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      response.flushHeaders()
      sseResponses.add(response)
      request.on("close", () => sseResponses.delete(response))
      return
    }
    if (request.method === "GET" && state.textNotFoundPaths.has(url.pathname)) {
      response.writeHead(404, { "Content-Type": "text/plain" })
      return response.end("not found")
    }
    if (request.method === "GET" && url.pathname === "/session/status") {
      return send(Object.fromEntries([...state.sessions.keys()].map((id) => [id, { type: state.busy.has(id) ? "busy" : "idle" }])))
    }
    if (request.method === "POST" && url.pathname === "/session") {
      const id = `ses_${state.sessions.size + 1}`
      state.directories.push(url.searchParams.get("directory"))
      state.sessions.set(id, { id, title: "t" })
      state.messages.set(id, [])
      return send({ id, title: "t", created_at: "2026-09-01T10:00:00Z", status: "idle" })
    }
    const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (request.method === "POST" && promptMatch) {
      // delayedBusyMs reproduces the real upstream's race: the session is not marked busy the
      // instant the prompt is accepted, so a naive poller can read "idle" before the turn starts.
      const markBusy = () => state.busy.add(promptMatch[1])
      if (delayedBusyMs > 0) setTimeout(markBusy, delayedBusyMs)
      else markBusy()
      const message = {
        id: `msg_${(state.messages.get(promptMatch[1]) ?? []).length + 1}`,
        role: "assistant", content: "done",
        created_at: "2026-09-01T10:00:01Z",
        info: { role: "assistant", finish: "stop" },
        parts: [{ type: "text", content: "done" }, { type: "step-finish" }]
      }
      state.messages.get(promptMatch[1])?.push(message)
      if (streamEvents) {
        broadcast({
          type: "message.part.updated",
          properties: { sessionID: promptMatch[1], messageID: message.id, part: message.parts[0] }
        })
      }
      state.promptResolvers.push(() => state.busy.delete(promptMatch[1]))
      return send(undefined, 204)
    }
    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (request.method === "GET" && messageMatch) return send(state.messages.get(messageMatch[1]) ?? [])
    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (request.method === "POST" && abortMatch) { state.busy.delete(abortMatch[1]); return send({ ok: true }) }
    if (request.method === "DELETE" && url.pathname.startsWith("/session/")) {
      state.sessions.delete(url.pathname.split("/")[2])
      return send({ ok: true })
    }
    if (request.method === "GET" && url.pathname === "/question") return send([])
    if (request.method === "GET" && url.pathname === "/permission") return send([])
    send({}, 404)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

  // Ends the SSE streams (the engine's event pump holds one open), then closes the server and
  // waits for its connections to drain so no handle leaks into the next test.
  async function close() {
    for (const response of sseResponses) response.end()
    server.closeIdleConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
    server.closeAllConnections?.()
  }

  return { server, state, port: server.address().port, close }
}
