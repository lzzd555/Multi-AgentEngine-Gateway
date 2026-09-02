// bridge/test/gateway-event-bus.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { createEventBus } from "../src/gateway/event-bus.js"

function fakeResponse() {
  const response = new PassThrough()
  response.headers = {}
  response.writeHead = (status, headers) => {
    response.statusCode = status
    Object.assign(response.headers, headers)
  }
  return response
}

function frames(stream) {
  const chunks = []
  stream.on("data", (chunk) => {
    for (const line of String(chunk).split("\n\n")) {
      if (line.startsWith("data: ")) chunks.push(JSON.parse(line.slice(6)))
    }
  })
  return chunks
}

test("connection emits server.connected immediately and heartbeats on the interval", async () => {
  const timers = new Map()
  const bus = createEventBus({
    heartbeatMs: 20,
    setIntervalImpl: (fn, ms) => { const id = Symbol("timer"); timers.set(id, { fn, ms }); return id },
    clearIntervalImpl: (id) => timers.delete(id)
  })
  const response = fakeResponse()
  const seen = frames(response)
  bus.handle({ on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen[0].type, "server.connected")
  assert.deepEqual(seen[0].properties, {})
  const timer = [...timers.values()][0]
  assert.equal(timer.ms, 20)
  timer.fn()
  assert.equal(seen[1].type, "server.heartbeat")
})

test("emit forwards spec-shaped events to all connections", async () => {
  const bus = createEventBus({
    heartbeatMs: 60_000,
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {}
  })
  const response = fakeResponse()
  const seen = frames(response)
  bus.handle({ on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  bus.emit({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.at(-1).type, "session.status")
  assert.equal(seen.at(-1).properties.sessionID, "s1")
})

test("response close clears the heartbeat timer", () => {
  const cleared = []
  const bus = createEventBus({
    heartbeatMs: 1000,
    setIntervalImpl: () => 1,
    clearIntervalImpl: (id) => cleared.push(id)
  })
  const request = new EventEmitter()
  const response = fakeResponse()
  bus.handle(request, response)
  request.emit("close")
  assert.deepEqual(cleared, [1])
})
