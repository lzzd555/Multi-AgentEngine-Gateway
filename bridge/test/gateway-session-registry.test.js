// bridge/test/gateway-session-registry.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createSessionRegistry } from "../src/gateway/session-registry.js"

test("register tracks a session and its lifecycle", () => {
  let tick = 0
  const registry = createSessionRegistry({ now: () => `2026-09-01T10:00:0${tick++}Z` })
  const record = registry.register({ id: "ses_1", title: "会话标题" })
  assert.deepEqual(record, { id: "ses_1", title: "会话标题", created_at: "2026-09-01T10:00:00Z", status: "idle" })
  assert.equal(registry.has("ses_1"), true)
  registry.setStatus("ses_1", "busy")
  assert.deepEqual(registry.statuses(), { ses_1: { type: "busy" } })
  registry.setStatus("ses_1", "idle")
  registry.remove("ses_1")
  assert.equal(registry.has("ses_1"), false)
  assert.deepEqual(registry.statuses(), {})
})

test("setStatus on an unknown session is a no-op", () => {
  const registry = createSessionRegistry()
  registry.setStatus("missing", "busy")
  assert.deepEqual(registry.statuses(), {})
})
