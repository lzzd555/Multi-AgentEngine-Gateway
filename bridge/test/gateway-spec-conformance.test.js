// bridge/test/gateway-spec-conformance.test.js
// The compliance evidence suite: one Appendix-B checklist run against BOTH engines — the OpenCode
// engine against a fake OpenCode upstream, and the omp engine through the real AcpService/AcpClient
// stack with FakeOmpAcp. Every assertion mirrors the spec tables: session CRUD, the blocking
// prompt with its completion markers, the SSE event names, idle/busy switching, abort, error
// bodies, the directory parameter, the engine factory, and the permission park→reply loop.
import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { buildGateway } from "../src/gateway/main.js"
import { createEngine } from "../src/gateway/engines/engine-adapter.js"
import { createFakeOpencodeUpstream } from "./helpers/fake-opencode-upstream.js"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"
import { isValidNormalizedMessage } from "../src/gateway/message-normalizer.js"

// The shipped assembly: buildGateway accepts a pre-built engineInstance, wires the engine's
// interaction hooks onto the gateway queue and forwards engine-emitted spec events onto the SSE
// bus — exactly what the /event contract owes the judge. The engine is wrapped only to observe
// the hooks buildGateway hands it; every hook called is the gateway's own.
async function startSpecGateway({ engineId, engine, defaultModel = "zai/glm-5.2" }) {
  let engineHooks
  const instrumented = {
    ...engine,
    onInteraction: (hooks) => { engineHooks = hooks; engine.onInteraction?.(hooks) }
  }
  const gateway = buildGateway({ engine: engineId, engineInstance: instrumented, host: "127.0.0.1", port: 0, defaultModel })
  await gateway.engine.initialize()
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve))
  return { ...gateway, hooks: engineHooks, base: `http://127.0.0.1:${gateway.server.address().port}` }
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

async function waitForEvent(events, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!events.some((event) => event.type === type) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// The Appendix-B checklist. Engine-specific behaviour (how the fake turn is released, whether
// part updates and the parked-permission loop apply) is injected through ctx.
async function runChecklist(ctx, { expectPartUpdates = false, expectPermissionPark = false } = {}) {
  const { base } = ctx
  const events = []
  const controller = new AbortController()
  const reading = readEvents(`${base}/event`, events, controller.signal)
  try {
    await waitFor(() => events.length > 0)
    assert.equal(events[0]?.type, "server.connected")

    // create / read sessions; the ?directory= parameter rides along to the engine
    const created = await (await fetch(`${base}/session?directory=${encodeURIComponent(ctx.directory)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "conformance" })
    })).json()
    assert.equal(created.status, "idle")
    assert.equal(created.title, "conformance")
    ctx.assertDirectoryForwarded?.()

    const fetched = await (await fetch(`${base}/session/${created.id}`)).json()
    assert.equal(fetched.title, "conformance")
    assert.equal(typeof fetched.message_count, "number")

    // prompt blocks until the engine turn finishes (204 only afterwards); SSE covers the
    // busy → part updates → idle transitions of the turn
    const promptResponse = fetch(`${base}/session/${created.id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "请自动打开 Outlook 邮件客户端" }], model: { providerID: "zai", modelID: "glm-5.2" } })
    })
    await ctx.settlePromptTurn?.(created)
    assert.equal((await promptResponse).status, 204)
    ctx.assertModelForwarded?.()
    await waitForEvent(events, "session.idle")
    const types = events.map((event) => event.type)
    assert.ok(types.includes("session.status"))
    assert.ok(types.includes("session.idle"))
    const busyEvent = events.find((event) => event.type === "session.status" && event.properties.status?.type === "busy")
    assert.ok(busyEvent, "a busy session.status event was emitted")
    assert.equal(busyEvent.properties.sessionID, created.id)
    const idleEvent = events.find((event) => event.type === "session.status" && event.properties.status?.type === "idle")
    assert.ok(idleEvent, "an idle session.status event was emitted")
    assert.equal(idleEvent.properties.sessionID, created.id)
    if (expectPartUpdates) {
      await waitForEvent(events, "message.part.updated")
      assert.ok(events.some((event) => event.type === "message.part.updated"), "a message.part.updated event was emitted")
    }

    // the final message passes the judge's completion rule
    const messages = await (await fetch(`${base}/session/${created.id}/message`)).json()
    const last = messages.at(-1)
    assert.equal(last.role, "assistant")
    assert.equal(last.info.finish, "stop")
    assert.ok(last.parts.some((part) => part.type === "step-finish"))
    assert.ok(isValidNormalizedMessage(last))

    // abort + status
    assert.deepEqual(await (await fetch(`${base}/session/${created.id}/abort`, { method: "POST" })).json(), { ok: true })
    const statuses = await (await fetch(`${base}/session/status`)).json()
    assert.deepEqual(statuses[created.id], { type: "idle" })

    // interaction endpoints exist with spec shapes
    assert.ok(Array.isArray(await (await fetch(`${base}/question`)).json()))
    assert.ok(Array.isArray(await (await fetch(`${base}/permission`)).json()))

    if (expectPermissionPark) {
      // the parked-permission loop: an engine ask lands on the queue, surfaces as an SSE
      // permission.asked event, and the HTTP reply resolves it
      const entry = ctx.hooks.askPermission({ sessionID: created.id, permission: "tool.execute", patterns: ["打开 Outlook"] })
      await waitForEvent(events, "permission.asked")
      const listed = await (await fetch(`${base}/permission`)).json()
      assert.equal(listed.length, 1)
      assert.equal(listed[0].permission, "tool.execute")
      assert.deepEqual(listed[0].patterns, ["打开 Outlook"])
      const reply = await fetch(`${base}/permission/${listed[0].id}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once", message: "允许" })
      })
      assert.equal(reply.status, 200)
      assert.deepEqual(await reply.json(), { ok: true })
      assert.deepEqual(await entry.settled, { reply: "once", message: "允许" })
      assert.deepEqual(await (await fetch(`${base}/permission`)).json(), [])
    }

    // error bodies follow the spec table
    const missing = await fetch(`${base}/session/ses_none`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { code: "NOT_FOUND", message: "Session not found" })

    // delete is {ok:true} and the session is gone afterwards
    const deleted = await fetch(`${base}/session/${created.id}`, { method: "DELETE" })
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { ok: true })
    assert.equal((await fetch(`${base}/session/${created.id}`)).status, 404)
  } finally {
    controller.abort()
    await reading
  }
}

test("conformance: opencode engine", async () => {
  const upstream = await createFakeOpencodeUpstream({ streamEvents: true })
  try {
    const engine = createEngine("opencode", { manageHost: false, upstreamPort: upstream.port, pollIntervalMs: 5, promptTimeoutMs: 2_000 })
    assert.equal(engine.id, "opencode") // --engine opencode resolves through the factory
    const ctx = await startSpecGateway({ engineId: "opencode", engine })
    ctx.directory = await mkdtemp(path.join(tmpdir(), "conformance-opencode-"))
    ctx.assertDirectoryForwarded = () => assert.equal(upstream.state.directories.at(-1), ctx.directory)
    ctx.settlePromptTurn = async (session) => {
      // the fake upstream keeps the session busy until the resolver is popped
      await waitFor(() => upstream.state.promptResolvers.length > 0)
      const statuses = await (await fetch(`${ctx.base}/session/status`)).json()
      assert.deepEqual(statuses[session.id], { type: "busy" }) // registry switched to busy mid-turn
      upstream.state.promptResolvers.pop()()
    }
    try {
      await runChecklist(ctx, { expectPartUpdates: true })
    } finally {
      ctx.server.close()
      await engine.dispose()
    }
  } finally {
    await upstream.close()
  }
})

test("conformance: omp engine (ACP)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conformance-omp-"))
  // The spec prompt carries model zai/glm-5.2; advertising it in the fake's catalog lets the
  // engine pass the request's model straight through to session/set_config_option.
  const acp = new FakeOmpAcp({
    sessionRoot: path.join(root, "sessions"),
    cwd: root,
    models: ["anthropic/claude-sonnet-4", "zai/glm-5.2"]
  })
  const engine = createEngine("omp", { acp, stateDirectory: path.join(root, "state") })
  assert.equal(engine.id, "omp") // --engine omp resolves through the factory
  // The gateway default is deliberately the session's starting model (anthropic/claude-sonnet-4,
  // the fake catalog's first entry), so any session/set_config_option carrying zai/glm-5.2 below
  // proves the request's model was forwarded — a fallback to the default would issue no call.
  const ctx = await startSpecGateway({ engineId: "omp", engine, defaultModel: "anthropic/claude-sonnet-4" })
  ctx.directory = root
  ctx.assertDirectoryForwarded = () => {
    const created = acp.calls("session/new").at(-1)
    assert.equal(created?.[1]?.cwd, root) // the ?directory= parameter reached the ACP adapter
  }
  ctx.assertModelForwarded = () => {
    const modelChange = acp.calls("session/set_config_option").find(([, params]) => params.configId === "model")
    assert.equal(modelChange?.[1]?.value, "zai/glm-5.2") // the prompt's model, not the gateway default
    assert.notEqual(modelChange?.[1]?.value, "anthropic/claude-sonnet-4")
  }
  ctx.settlePromptTurn = async () => {} // the ACP fake finishes the turn on its own
  try {
    await runChecklist(ctx, { expectPartUpdates: true, expectPermissionPark: true })
  } finally {
    ctx.server.close()
    await engine.dispose()
  }
})
