// bridge/test/gateway-interaction-queue.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"

test("permission lifecycle: add, list, resolve, disappear", async () => {
  const queue = createInteractionQueue({ now: () => "2026-09-01T10:00:00Z" })
  const { id, settled } = queue.addPermission("ses_1", "file.write", ["/tmp/a.txt"])
  assert.deepEqual(queue.listPermissions(), [{
    id, sessionID: "ses_1", permission: "file.write", patterns: ["/tmp/a.txt"], created_at: "2026-09-01T10:00:00Z"
  }])
  assert.equal(queue.resolvePermission(id, { reply: "always", message: "ok" }), true)
  assert.deepEqual(await settled, { reply: "always", message: "ok" })
  assert.deepEqual(queue.listPermissions(), [])
  assert.equal(queue.resolvePermission(id, { reply: "once" }), false)
})

test("question lifecycle with answers payload", async () => {
  const queue = createInteractionQueue()
  const { id, settled } = queue.addQuestion("ses_1", [{ question: "选哪个?", options: [{ label: "A" }] }])
  assert.equal(queue.listQuestions().length, 1)
  queue.resolveQuestion(id, [["A"]])
  assert.deepEqual(await settled, { answers: [["A"]] })
  assert.deepEqual(queue.listQuestions(), [])
})

test("double resolve is rejected", () => {
  const queue = createInteractionQueue()
  const { id } = queue.addQuestion("ses_1", [])
  assert.equal(queue.resolveQuestion(id, [["A"]]), true)
  assert.equal(queue.resolveQuestion(id, [["B"]]), false)
})
