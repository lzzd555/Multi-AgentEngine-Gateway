// bridge/test/gateway-server-sessions.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createGatewayServer } from "../src/gateway/gateway-server.js"
import { createEventBus } from "../src/gateway/event-bus.js"
import { createSessionRegistry } from "../src/gateway/session-registry.js"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"
import { createFakeEngine } from "./helpers/fake-engine.js"

async function startGateway(engineOptions = {}) {
  const engine = createFakeEngine(engineOptions)
  const gateway = createGatewayServer({
    engine,
    eventBus: createEventBus(),
    registry: createSessionRegistry(),
    interactionQueue: createInteractionQueue(),
    defaultModel: "zai/glm-5.2"
  })
  const server = gateway.server
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { engine, server, base: `http://127.0.0.1:${server.address().port}` }
}

test("session create, read, status and delete follow the spec", async () => {
  const { engine, server, base } = await startGateway()
  try {
    const created = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "会话标题" })
    })
    assert.equal(created.status, 200)
    const session = await created.json()
    assert.equal(session.title, "会话标题")
    assert.equal(session.status, "idle")
    assert.match(session.created_at, /^\d{4}-/)
    engine.setMessages(session.id, [
      { id: "m1", role: "user", content: "q", created_at: "2026-09-01T10:00:00Z" },
      { id: "m2", role: "assistant", content: "a", created_at: "2026-09-01T10:00:01Z",
        info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", content: "a" }, { type: "step-finish" }] }
    ])
    const read = await (await fetch(`${base}/session/${session.id}`)).json()
    assert.equal(read.message_count, 2)
    const statuses = await (await fetch(`${base}/session/status`)).json()
    assert.deepEqual(statuses[session.id], { type: "idle" })
    const removed = await (await fetch(`${base}/session/${session.id}`, { method: "DELETE" })).json()
    assert.deepEqual(removed, { ok: true })
    assert.equal((await fetch(`${base}/session/${session.id}`)).status, 404)
  } finally {
    server.close()
  }
})

test("missing title returns the spec validation error", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: "VALIDATION_ERROR", message: "title is required" })
  } finally {
    server.close()
  }
})

test("unknown session yields the spec not-found body", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session/ses_missing`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { code: "NOT_FOUND", message: "Session not found" })
  } finally {
    server.close()
  }
})

test("malformed JSON yields 400 with error body", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops"
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})
