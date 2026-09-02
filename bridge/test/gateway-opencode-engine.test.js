// bridge/test/gateway-opencode-engine.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createOpenCodeEngine } from "../src/gateway/engines/opencode-engine.js"
import { createFakeOpencodeUpstream } from "./helpers/fake-opencode-upstream.js"

async function withFakeUpstream(run) {
  const upstream = await createFakeOpencodeUpstream()
  try {
    return await run(upstream, upstream.port)
  } finally {
    await upstream.close()
  }
}

test("session lifecycle and blocking prompt against a fake upstream", async () => {
  await withFakeUpstream(async (upstream, port) => {
    const engine = createOpenCodeEngine({ manageHost: false, upstreamPort: port, pollIntervalMs: 5, promptTimeoutMs: 2_000 })
    await engine.initialize()
    const { id } = await engine.createSession({ title: "t" })
    assert.equal(typeof id, "string")

    let promptDone = false
    const promptPromise = engine.prompt(id, { text: "hi", model: "zai/glm-5.2" }).then(() => { promptDone = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(promptDone, false) // still busy upstream
    assert.deepEqual(await engine.listSessionStatuses(), { [id]: { type: "busy" } })

    upstream.state.promptResolvers.pop()() // upstream goes idle
    await promptPromise
    assert.equal(promptDone, true)
    assert.deepEqual(await engine.listSessionStatuses(), { [id]: { type: "idle" } })

    const messages = await engine.listMessages(id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.finish, "stop")

    await engine.abort(id)
    await engine.deleteSession(id)
    assert.deepEqual(await engine.listSessionStatuses(), {})
    await engine.dispose()
  })
})

test("question and permission reads are proxied", async () => {
  await withFakeUpstream(async (_, port) => {
    const engine = createOpenCodeEngine({ manageHost: false, upstreamPort: port })
    await engine.initialize()
    assert.deepEqual(await engine.listQuestions(), [])
    assert.deepEqual(await engine.listPermissions(), [])
    await engine.replyQuestion("req_x", [["A"]])
    await engine.replyPermission("perm_x", { reply: "once" })
    await engine.dispose()
  })
})

test("question and permission reads tolerate upstream 404 text bodies", async () => {
  await withFakeUpstream(async (upstream, port) => {
    upstream.state.textNotFoundPaths.add("/question")
    upstream.state.textNotFoundPaths.add("/permission")
    const engine = createOpenCodeEngine({ manageHost: false, upstreamPort: port })
    await engine.initialize()
    assert.deepEqual(await engine.listQuestions(), [])
    assert.deepEqual(await engine.listPermissions(), [])
    await engine.dispose()
  })
})

test("delayed busy marking does not make prompt resolve before the turn ends", async () => {
  const { createFakeOpencodeUpstream } = await import("./helpers/fake-opencode-upstream.js")
  const upstream = await createFakeOpencodeUpstream({ delayedBusyMs: 40 })
  try {
    const engine = createOpenCodeEngine({ manageHost: false, upstreamPort: upstream.port, pollIntervalMs: 5, promptTimeoutMs: 6_000 })
    await engine.initialize()
    const { id } = await engine.createSession({ title: "t" })
    let done = false
    const promptPromise = engine.prompt(id, { text: "hi" }).then(() => { done = true })
    // Phase 1: before the upstream marks busy (40ms), the old code resolved here — the regression.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(done, false, "prompt still pending during the not-yet-busy window")
    // Phase 2: busy is marked at 40ms and observed by the poller; releasing then must resolve.
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(done, false, "prompt still pending while the turn holds busy")
    assert.equal(upstream.state.busy.has(id), true, "upstream is busy before release")
    upstream.state.promptResolvers.pop()() // release the turn
    await promptPromise
    assert.equal(done, true)
    const messages = await engine.listMessages(id)
    assert.equal(messages.length, 1, "message recorded once the turn actually ran")
    await engine.dispose()
  } finally {
    await upstream.close()
  }
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.pid = 4242
  child.kill = () => true
  return child
}

test("engine injects env and args into the managed host spawn", async () => {
  const spawns = []
  const engine = createOpenCodeEngine({
    command: "/opt/opencode/bin/opencode",
    args: ["--flag"],
    env: { OPENCODE_CONFIG: "/tmp/generated/opencode.json" },
    spawnProcess: (command, args, options) => { spawns.push({ command, args, options }); return fakeChild() },
    startTimeoutMs: 5,
    waitUntilReady: async () => {}
  })
  await engine.initialize()
  const spawn = spawns.at(-1)
  assert.equal(spawn.command, "/opt/opencode/bin/opencode")
  assert.deepEqual(spawn.args, ["serve", "--hostname", "127.0.0.1", "--port", "14096", "--flag"])
  assert.equal(spawn.options.env.OPENCODE_CONFIG, "/tmp/generated/opencode.json")
  // env 是叠加在 process.env 之上，而非整体替换
  assert.equal(spawn.options.env.PATH, process.env.PATH)
  await engine.dispose()
})
