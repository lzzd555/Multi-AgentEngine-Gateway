// bridge/test/gateway-acp-engine.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"
import { createAcpEngine, permissionDecision, redirectProfile } from "../src/gateway/engines/acp-engine.js"
import { HARNESS_PROFILES } from "../src/harness-profiles.js"

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

function fakeAcpChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.kill = () => true
  return child
}

test("redirectProfile moves omp journals and undo-redo runtime under PI_CONFIG_DIR", () => {
  const redirected = redirectProfile(HARNESS_PROFILES.omp, { PI_CONFIG_DIR: ".multi-agentengine-gateway/omp" })
  assert.notEqual(redirected, HARNESS_PROFILES.omp)
  assert.notEqual(redirected.historyLoader, HARNESS_PROFILES.omp.historyLoader)
  assert.equal(redirected.actionProviders.length, HARNESS_PROFILES.omp.actionProviders.length)
})

test("redirectProfile moves pi sessions under PI_CODING_AGENT_DIR", () => {
  const redirected = redirectProfile(HARNESS_PROFILES.pi, { PI_CODING_AGENT_DIR: "/tmp/gw/pi/agent" })
  assert.ok(redirected.historyLoader)
  assert.equal(redirected.actionProviders, HARNESS_PROFILES.pi.actionProviders)
})

test("redirectProfile returns the profile untouched without matching env", () => {
  assert.equal(redirectProfile(HARNESS_PROFILES.omp, {}), HARNESS_PROFILES.omp)
  assert.equal(redirectProfile(HARNESS_PROFILES.pi, { PI_CONFIG_DIR: "x" }), HARNESS_PROFILES.pi)
})

test("engine passes command override and env injection into the spawned adapter", async () => {
  const spawns = []
  const engine = createAcpEngine({
    profileId: "pi",
    command: "/usr/local/bin/pi-acp",
    args: [],
    env: { PI_CODING_AGENT_DIR: "/tmp/gw/pi/agent" },
    spawnProcess: (command, args, options) => { spawns.push({ command, args, options }); return fakeAcpChild() }
  })
  await assert.rejects(() => engine.initialize())
  const spawn = spawns.at(-1)
  assert.equal(spawn.command, "/usr/local/bin/pi-acp")
  assert.deepEqual(spawn.args, [])
  assert.equal(spawn.options.env.PI_CODING_AGENT_DIR, "/tmp/gw/pi/agent")
  assert.ok(spawn.options.env.PATH !== undefined || Object.keys(spawn.options.env).length > 1)
})

// omp 的 ACP 模式刻意关闭磁盘 mcp.json 发现（enableMCP:false），MCP 服务器只能由 ACP 客户端经
// session/new.mcpServers 下发；pi 走本地 adapter 读盘，重复下发会双挂载，必须保持空。
const ENGINE_MCP = {
  fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: { K: "V" } },
  context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: {} }
}

test("omp engine forwards configured mcp servers through session/new", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-mcp-"))
  const acp = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  const engine = createAcpEngine({
    profileId: "omp",
    acp,
    stateDirectory: path.join(root, "state"),
    mcp: ENGINE_MCP
  })
  try {
    await engine.initialize()
    await engine.createSession({ title: "mcp" })
    const params = acp.calls("session/new").at(-1)[1]
    assert.deepEqual(params.mcpServers, [
      { name: "fetch", command: "npx", args: ["-y", "mcp-server-fetch"], env: [{ name: "K", value: "V" }] },
      { name: "context7", type: "http", url: "https://mcp.context7.com/mcp", headers: [] }
    ])
  } finally {
    await engine.dispose()
  }
})

test("pi engine keeps session/new mcpServers empty (on-disk adapter path)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-pimcp-"))
  const acp = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  const engine = createAcpEngine({
    profileId: "pi",
    acp,
    stateDirectory: path.join(root, "state"),
    mcp: ENGINE_MCP
  })
  try {
    await engine.initialize()
    await engine.createSession({ title: "pi-mcp" })
    const params = acp.calls("session/new").at(-1)[1]
    assert.deepEqual(params.mcpServers, [])
  } finally {
    await engine.dispose()
  }
})

test("omp engine without configured mcp still sends an empty mcpServers array", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-nomcp-"))
  const acp = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  const engine = createAcpEngine({ profileId: "omp", acp, stateDirectory: path.join(root, "state") })
  try {
    await engine.initialize()
    await engine.createSession({ title: "bare" })
    assert.deepEqual(acp.calls("session/new").at(-1)[1].mcpServers, [])
  } finally {
    await engine.dispose()
  }
})

// 重启后重开走 session/load（或 resume），omp 在这两条路径上同样按 mcpServers 重建 MCP——
// 网关必须在重开时下发同一列表，否则配置的 MCP 在重启后静默消失。
test("AcpService carries configured mcpServers into session/load and session/resume", async () => {
  const { AcpService } = await import("../src/acp-service.js")
  const root = await mkdtemp(path.join(tmpdir(), "gateway-acp-reopen-"))
  const servers = [{ name: "fetch", command: "npx", args: ["-y", "mcp-server-fetch"], env: [] }]

  const loader = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  await loader.seedSession("omp-reopen-1", { entries: [], title: undefined })
  const loadService = new AcpService(loader, { mcpServers: servers })
  await loadService.claimSession("omp-reopen-1")
  assert.deepEqual(loader.calls("session/load").at(-1)[1].mcpServers, servers)

  const resumed = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  await resumed.seedSession("omp-reopen-2", { entries: [], title: undefined })
  // journalPageWhileOwned:false + resume 能力 → 重开走 session/resume（omp profile 的形态）
  const resumeService = new AcpService(resumed, { journalPageWhileOwned: false, mcpServers: servers })
  await resumeService.claimSession("omp-reopen-2")
  assert.deepEqual(resumed.calls("session/resume").at(-1)[1].mcpServers, servers)
})
