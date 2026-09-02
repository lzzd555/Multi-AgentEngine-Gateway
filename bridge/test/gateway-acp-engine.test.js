// bridge/test/gateway-acp-engine.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"
import { createAcpEngine, permissionDecision } from "../src/gateway/engines/acp-engine.js"

async function acpFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-"))
  const acp = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  const engine = createAcpEngine({ profileId: "omp", acp, stateDirectory: path.join(root, "state") })
  await engine.initialize()
  return { engine, acp, root }
}

test("create → blocking prompt → final message finish=stop with step-finish", async () => {
  const { engine } = await acpFixture()
  const events = []
  engine.subscribe((event) => events.push(event))
  const { id } = await engine.createSession({ title: "t" })
  // FakeOmpAcp answers a prompt with one assistant text message and ends the turn.
  await engine.prompt(id, { text: "hi", model: "anthropic/claude-sonnet-4" })
  assert.deepEqual(await engine.listSessionStatuses(), { [id]: { type: "idle" } })
  const messages = await engine.listMessages(id)
  const last = messages.at(-1)
  assert.equal(last.role, "assistant")
  assert.equal(last.info.finish, "stop")
  assert.ok(last.parts.some((part) => part.type === "step-finish"))
  const types = events.map((event) => event.type)
  assert.ok(types.includes("session.status"))
  assert.ok(types.includes("session.idle"))
  await engine.deleteSession(id)
  await engine.dispose()
})

// The ACP permission protocol travels over the child's stdio, so the parked decision is asserted
// on the reply frame the engine's client writes to the adapter (the adapter's side of the pipe).
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.pid = 4242
  child.kill = () => { child.killed = true }
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

test("permission requests park until the gateway reply resolves them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-park-"))
  const child = fakeChild()
  const seen = frames(child.stdin)
  const engine = createAcpEngine({
    profileId: "omp",
    stateDirectory: path.join(root, "state"),
    spawnProcess: () => child
  })
  const started = engine.initialize()
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started

  const asked = []
  let answer
  engine.onInteraction({
    askQuestion: () => {},
    askPermission: (record) => {
      asked.push(record)
      let resolveSettled
      const settled = new Promise((resolve) => { resolveSettled = resolve })
      answer = resolveSettled
      return { id: "req_1", settled }
    }
  })

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 100, method: "session/request_permission",
    params: { sessionId: "s1", options: [
      { kind: "allow_once", optionId: "o1", name: "Allow" },
      { kind: "allow_always", optionId: "o2", name: "Always allow" }
    ] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(asked.length, 1, "the ask reached the gateway hook")
  assert.equal(asked[0].sessionID, "s1")
  assert.equal(asked[0].permission, "tool.execute")
  assert.deepEqual(asked[0].patterns, ["Allow", "Always allow"])
  assert.equal(seen.filter((frame) => frame.id === 100).length, 0, "no reply before the judge answers")
  answer({ reply: "always" })
  await new Promise((resolve) => setImmediate(resolve))
  const reply = seen.find((frame) => frame.id === 100)
  assert.deepEqual(reply.result.outcome, { outcome: "selected", optionId: "o2" })
  await engine.dispose()
})

test("permissionDecision maps spec replies onto the offered options", () => {
  const options = [
    { kind: "allow_once", optionId: "o1" }, { kind: "allow_always", optionId: "o2" }
  ]
  assert.deepEqual(permissionDecision({ reply: "once" }, options), { optionId: "o1" })
  assert.deepEqual(permissionDecision({ reply: "always" }, options), { optionId: "o2" })
  assert.equal(permissionDecision({ reply: "reject" }, options), null)
  assert.deepEqual(
    permissionDecision({ reply: "reject" }, [...options, { kind: "reject", optionId: "o3" }]),
    { optionId: "o3" }
  )
})

test("a trailing error after a terminal reply does not fail the prompt", async () => {
  const acpStub = { on: () => {}, start: async () => {}, request: async () => ({}), notify: () => {}, close: () => {} }
  const repliedTurn = [
    { info: { id: "u1", role: "user", sessionID: "s1", time: { created: 1 } }, parts: [{ type: "text", text: "hi" }] },
    { info: { id: "a1", role: "assistant", sessionID: "s1", time: { created: 2 } }, parts: [{ type: "text", text: "done" }] }
  ]
  const serviceStub = {
    subscribe: () => () => {},
    createSession: async () => ({ id: "s1" }),
    deleteSession: async () => {},
    status: () => ({ type: "idle" }),
    messages: async () => repliedTurn,
    abort: () => {},
    promptAndWait: async () => { throw new Error("Internal error: provider error") }
  }
  const engine = createAcpEngine({ profileId: "omp", acp: acpStub, service: serviceStub })
  await engine.prompt("s1", { text: "hi" }) // must resolve: reply exists despite the error
})

test("a turn that failed without any reply still rejects", async () => {
  const acpStub = { on: () => {}, start: async () => {}, request: async () => ({}), notify: () => {}, close: () => {} }
  const serviceStub = {
    subscribe: () => () => {},
    createSession: async () => ({ id: "s1" }),
    deleteSession: async () => {},
    status: () => ({ type: "idle" }),
    messages: async () => [
      { info: { id: "u1", role: "user", sessionID: "s1", time: { created: 1 } }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "a1", role: "assistant", sessionID: "s1", time: { created: 2 } }, parts: [] }
    ],
    abort: () => {},
    promptAndWait: async () => { throw new Error("Internal error: provider error") }
  }
  const engine = createAcpEngine({ profileId: "omp", acp: acpStub, service: serviceStub })
  await assert.rejects(() => engine.prompt("s1", { text: "hi" }), /provider error/)
})
