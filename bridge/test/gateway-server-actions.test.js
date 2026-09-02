// bridge/test/gateway-server-actions.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createGatewayServer } from "../src/gateway/gateway-server.js"
import { createEventBus } from "../src/gateway/event-bus.js"
import { createSessionRegistry } from "../src/gateway/session-registry.js"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"
import { createFakeEngine } from "./helpers/fake-engine.js"

async function startGateway({ engine = createFakeEngine() } = {}) {
  const eventBus = createEventBus()
  const gateway = createGatewayServer({
    engine,
    eventBus,
    registry: createSessionRegistry(),
    interactionQueue: createInteractionQueue(),
    defaultModel: "zai/glm-5.2"
  })
  const server = gateway.server
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { engine, eventBus, gateway, server, base: `http://127.0.0.1:${server.address().port}` }
}

async function createSession(base) {
  const response = await fetch(`${base}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "t" })
  })
  return (await response.json()).id
}

// Minimal fetch-based SSE reader standing in for EventSource (no global EventSource on this Node):
// reads the /event stream, splits frames on "\n\n" and pushes each "data: " payload into events.
// Aborting the signal tears the stream down without leaking the connection.
async function readEvents(url, events, signal) {
  const response = await fetch(url, { signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf("\n\n")
      while (separator !== -1) {
        const frame = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice("data: ".length)))
        }
        separator = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function waitForEvent(events, type, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!events.some((event) => event.type === type) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("prompt_async blocks until the engine turn finishes and emits status events", async () => {
  const { engine, server, base } = await startGateway()
  const controller = new AbortController()
  try {
    const id = await createSession(base)
    let release
    engine.setPromptHandler(() => new Promise((resolve) => { release = resolve }))
    const seen = []
    const reading = readEvents(`${base}/event`, seen, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const promptPromise = fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "打开Outlook" }], model: { providerID: "zai", modelID: "glm-5.2" } })
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await Promise.race([promptPromise, Promise.resolve("pending")]), "pending") // still blocking
    release()
    const response = await promptPromise
    assert.equal(response.status, 204)
    await waitForEvent(seen, "session.idle")
    controller.abort()
    await reading
    assert.equal(seen[0].type, "server.connected")
    const types = seen.map((event) => event.type)
    assert.ok(types.includes("session.status"))
    assert.ok(types.includes("session.idle"))
    const busyEvent = seen.find((event) => event.type === "session.status" && event.properties.status?.type === "busy")
    assert.ok(busyEvent, "busy status event was emitted")
    assert.equal(busyEvent.properties.sessionID, id)
    const idleEvent = seen.find((event) => event.type === "session.status" && event.properties.status?.type === "idle")
    assert.ok(idleEvent, "idle status event was emitted")
    assert.equal(idleEvent.properties.sessionID, id)
  } finally {
    controller.abort()
    server.close()
  }
})

test("prompt without parts is a validation error", async () => {
  const { server, base } = await startGateway()
  try {
    const id = await createSession(base)
    const response = await fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})

test("prompt on an unknown session is a spec not-found", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session/ses_missing/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "x" }] })
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, "NOT_FOUND")
  } finally {
    server.close()
  }
})

test("messages, abort and stop aliases work", async () => {
  const { engine, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    engine.setMessages(id, [
      { id: "m1", role: "user", content: "q", created_at: "2026-09-01T10:00:00Z" }
    ])
    const messages = await (await fetch(`${base}/session/${id}/message`)).json()
    assert.equal(messages.length, 1)
    assert.deepEqual(await (await fetch(`${base}/session/${id}/abort`, { method: "POST" })).json(), { ok: true })
    assert.deepEqual(await (await fetch(`${base}/session/${id}/stop`, { method: "POST" })).json(), { ok: true })
  } finally {
    server.close()
  }
})

test("engine unavailability surfaces as 502 BAD_GATEWAY", async () => {
  const engine = createFakeEngine()
  engine.setPromptHandler(() => { throw Object.assign(new Error("upstream died"), { code: "ENGINE_UNAVAILABLE" }) })
  const { server, base } = await startGateway({ engine })
  try {
    const id = await createSession(base)
    const response = await fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "x" }] })
    })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).code, "BAD_GATEWAY")
  } finally {
    server.close()
  }
})

test("questions are empty and replies 404 for engines without the capability", async () => {
  const { server, base } = await startGateway()
  try {
    assert.deepEqual(await (await fetch(`${base}/question`)).json(), [])
    const response = await fetch(`${base}/question/req_x/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [["A"]] })
    })
    assert.equal(response.status, 404)
  } finally {
    server.close()
  }
})

test("askQuestion registers in the queue, emits question.asked and the reply resolves it", async () => {
  const { eventBus, gateway, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    const asked = []
    const unsubscribe = eventBus.subscribe((event) => asked.push(event))
    const questions = [["A", "B"]]
    const entry = gateway.askQuestion({ sessionID: id, questions })
    unsubscribe()

    assert.equal(asked.length, 1)
    assert.deepEqual(
      asked[0],
      { type: "question.asked", properties: { sessionID: id, id: entry.id, questions } }
    )
    // capabilities.questions is false on the fake engine, so listing stays [] but the reply still settles the queue.
    assert.deepEqual(await (await fetch(`${base}/question`)).json(), [])
    const reply = await fetch(`${base}/question/${entry.id}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [["A"]] })
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(await reply.json(), { ok: true })
    assert.deepEqual(await entry.settled, { answers: [["A"]] })
    assert.deepEqual(await (await fetch(`${base}/question`)).json(), [])
  } finally {
    server.close()
  }
})

test("question reply without answers is a validation error", async () => {
  const { gateway, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    const entry = gateway.askQuestion({ sessionID: id, questions: [["A"]] })
    const response = await fetch(`${base}/question/${entry.id}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})

test("permission ask flows through the queue and reply resolves it", async () => {
  const { eventBus, gateway, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    const asked = []
    const unsubscribe = eventBus.subscribe((event) => asked.push(event))
    const patterns = ["rm -rf /tmp/x"]
    const entry = gateway.askPermission({ sessionID: id, permission: "bash.execute", patterns })
    unsubscribe()

    assert.equal(asked.length, 1)
    assert.deepEqual(
      asked[0],
      { type: "permission.asked", properties: { sessionID: id, id: entry.id, permission: "bash.execute", patterns } }
    )
    const listed = await (await fetch(`${base}/permission`)).json()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].permission, "bash.execute")
    assert.deepEqual(listed[0].patterns, patterns)
    const reply = await fetch(`${base}/permission/${listed[0].id}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "always", message: "允许" })
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(await reply.json(), { ok: true })
    assert.deepEqual(await entry.settled, { reply: "always", message: "允许" })
    assert.deepEqual(await (await fetch(`${base}/permission`)).json(), [])
  } finally {
    server.close()
  }
})

test("permission reply with an unknown decision is a validation error", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/permission/req_none/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "maybe" })
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})

test("permission reply for an unknown request is a spec not-found", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/permission/req_none/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" })
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, "NOT_FOUND")
  } finally {
    server.close()
  }
})
