import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { AcpClient } from "../src/acp-client.js"

// ACP wraps the permission decision in a `result.outcome` envelope, and the reply the client
// writes travels on the child's stdin (the adapter's side of the pipe), so both are asserted
// there rather than on stdout (see the legacy tests in acp-client.test.js).
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.pid = 4242
  return child
}

function frames(stream) {
  const seen = []
  stream.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) seen.push(JSON.parse(line))
    }
  })
  return seen
}

async function startedClient(child) {
  const client = new AcpClient({ command: "fake", spawnProcess: () => child })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started
  return client
}

test("an injected handler parks the permission until it resolves an option", async () => {
  const child = fakeChild()
  const seen = frames(child.stdin)
  let decide
  const handler = () => new Promise((resolve) => { decide = resolve })
  const client = new AcpClient({ command: "fake", permissionHandler: handler, spawnProcess: () => child })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 100, method: "session/request_permission",
    params: { sessionId: "s1", options: [
      { kind: "allow_once", optionId: "o1" }, { kind: "reject", optionId: "o2" }
    ] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.filter((frame) => frame.id === 100).length, 0, "no reply before the handler resolves")
  decide({ optionId: "o2" })
  await new Promise((resolve) => setImmediate(resolve))
  const reply = seen.find((frame) => frame.id === 100)
  assert.deepEqual(reply.result.outcome, { outcome: "selected", optionId: "o2" })
})

test("a handler returning null cancels the request", async () => {
  const child = fakeChild()
  const seen = frames(child.stdin)
  const client = new AcpClient({ command: "fake", permissionMode: "allow", permissionHandler: () => Promise.resolve(null), spawnProcess: () => child })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 101, method: "session/request_permission",
    params: { sessionId: "s1", options: [{ kind: "allow_once", optionId: "o1" }] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen.find((frame) => frame.id === 101).result.outcome, { outcome: "cancelled" })
})

test("a throwing handler cancels the request instead of leaving it unanswered", async () => {
  const child = fakeChild()
  const seen = frames(child.stdin)
  const client = new AcpClient({
    command: "fake",
    permissionMode: "allow",
    permissionHandler: () => Promise.reject(new Error("queue shut down")),
    spawnProcess: () => child
  })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 103, method: "session/request_permission",
    params: { sessionId: "s1", options: [{ kind: "allow_once", optionId: "o1" }] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen.find((frame) => frame.id === 103).result.outcome, { outcome: "cancelled" })
})

test("without a handler the legacy auto-grant is unchanged", async () => {
  const child = fakeChild()
  const seen = frames(child.stdin)
  const client = new AcpClient({ command: "fake", permissionMode: "allow", spawnProcess: () => child })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 102, method: "session/request_permission",
    params: { sessionId: "s1", options: [
      { kind: "allow_once", optionId: "o1" }, { kind: "allow_always", optionId: "o3" }
    ] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen.find((frame) => frame.id === 102).result.outcome, { outcome: "selected", optionId: "o1" })
})
