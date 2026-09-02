// bridge/test/gateway-main.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildGateway, isDirectExecution } from "../src/gateway/main.js"
import { createFakeEngine } from "./helpers/fake-engine.js"

test("buildGateway wires engine events into the SSE bus", async () => {
  const gateway = buildGateway({
    engine: "opencode",
    host: "127.0.0.1",
    port: 0,
    defaultModel: "zai/glm-5.2",
    engineOptions: { manageHost: false, upstreamPort: 1 } // never dialed in this test
  })
  const seen = []
  gateway.eventBus.subscribe((event) => seen.push(event))
  assert.equal(gateway.engine.id, "opencode")
  assert.equal(typeof gateway.server.listen, "function")
  gateway.eventBus.emit({ type: "session.idle", properties: { sessionID: "s" } })
  assert.equal(seen.at(-1).type, "session.idle")
})

test("buildGateway forwards engine events onto the SSE bus and accepts a pre-built engine", () => {
  const engine = createFakeEngine()
  const gateway = buildGateway({ engine: "opencode", engineInstance: engine, defaultModel: "zai/glm-5.2" })
  assert.equal(gateway.engine, engine, "engineInstance is used instead of the factory path")
  const seen = []
  gateway.eventBus.subscribe((event) => seen.push(event))
  const partEvent = { type: "message.part.updated", properties: { sessionID: "s1", messageID: "m1", part: { type: "text", content: "hi" } } }
  engine.emit(partEvent)
  assert.deepEqual(seen.at(-1), partEvent)
})

test("isDirectExecution matches symlinked bins and rejects everything else", () => {
  const modulePath = fileURLToPath(new URL("../src/gateway/main.js", import.meta.url))
  assert.equal(isDirectExecution(modulePath, modulePath), true)
  assert.equal(isDirectExecution(undefined, modulePath), false)
  assert.equal(isDirectExecution(fileURLToPath(import.meta.url), modulePath), false) // a different real file
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-guard-"))
  try {
    const linkPath = path.join(dir, "harness-gateway")
    symlinkSync(modulePath, linkPath)
    assert.equal(isDirectExecution(linkPath, modulePath), true)
    assert.equal(isDirectExecution(path.join(dir, "missing"), modulePath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
