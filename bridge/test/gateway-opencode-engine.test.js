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
    waitUntilReady: async () => {},
    // 本测试只断言 spawn 参数；注入直接抛错的 fetch，避免 initialize 的 SSE 泵对默认端口
    // 发起真实网络请求——若本机恰有 opencode serve 监听 14096，真实 SSE 会挂住 reader 导致
    // 测试进程无法退出。
    fetchImpl: async () => { throw new Error("unit test: no upstream") }
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

test("directory-scoped sessions: create records mapping and routes per-session requests", async () => {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body })
    if (String(url).endsWith("/session?directory=%2Ftmp%2FdirA") && init.method === "POST") {
      return new Response(JSON.stringify({ id: "ses_dirA" }), { status: 200 })
    }
    if (String(url).includes("/ses_dirA/message")) return new Response("[]", { status: 200 })
    if (String(url).includes("/ses_dirA/prompt_async")) return new Response(null, { status: 204 })
    if (String(url).endsWith("/session/status")) return new Response(JSON.stringify({ ses_dirA: { type: "idle" } }), { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl, promptTimeoutMs: 800, pollIntervalMs: 20 })
  await engine.initialize()
  await engine.createSession({ title: "a", directory: "/tmp/dirA" })
  // 建会话带了 directory 查询
  assert.ok(requests.some((r) => r.url.endsWith("/session?directory=%2Ftmp%2FdirA") && r.method === "POST"))
  await engine.prompt("ses_dirA", { text: "hi", model: "zaicoding/glm-5.2" })
  // prompt 与 message 均注入 directory
  assert.ok(requests.some((r) => r.url.includes("/ses_dirA/prompt_async?directory=") && r.method === "POST"))
  await engine.listMessages("ses_dirA")
  assert.ok(requests.some((r) => r.url.includes("/ses_dirA/message?directory=")))
  await engine.dispose()
})

test("directory-scoped sessions: unmapped sessions keep unscoped request paths", async () => {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET" })
    if (String(url).endsWith("/session") && init.method === "POST") return new Response(JSON.stringify({ id: "ses_plain" }), { status: 200 })
    if (String(url).includes("/ses_plain/message")) return new Response("[]", { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl })
  await engine.initialize()
  await engine.createSession({ title: "p" })
  await engine.listMessages("ses_plain")
  const msgReq = requests.find((r) => r.url.includes("/ses_plain/message"))
  assert.ok(msgReq, "message request made")
  assert.ok(!msgReq.url.includes("directory="), "no directory injected for unscoped session")
  await engine.dispose()
})

test("directory-scoped sessions: SSE subscription opened per directory, shared and disposed", async () => {
  const sseRequests = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    sseRequests.push({ url: u, signal: init.signal })
    if (u.includes("/event")) {
      // 无 body 的 SSE：挂起直到 signal abort
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n"))
          init.signal?.addEventListener("abort", () => controller.close())
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    if (u.endsWith("/session?directory=%2Ftmp%2FdirB") && init.method === "POST") return new Response(JSON.stringify({ id: "ses_b1" }), { status: 200 })
    if (u.endsWith("/session?directory=%2Ftmp%2FdirC") && init.method === "POST") return new Response(JSON.stringify({ id: "ses_c1" }), { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl })
  await engine.initialize()
  await engine.createSession({ title: "b", directory: "/tmp/dirB" })
  await engine.createSession({ title: "b2", directory: "/tmp/dirB/" }) // 尾斜杠归一后同目录
  await engine.createSession({ title: "c", directory: "/tmp/dirC" })
  await new Promise((r) => setTimeout(r, 50))
  // 默认 /event 一条 + dirB 一条 + dirC 一条（dirB 复用，不重复开）
  const eventReqs = sseRequests.filter((r) => r.url.includes("/event"))
  assert.equal(eventReqs.filter((r) => r.url.includes("dirB")).length, 1)
  assert.equal(eventReqs.filter((r) => r.url.includes("dirC")).length, 1)
  assert.ok(eventReqs.some((r) => !r.url.includes("directory=")), "default unscoped stream kept")
  await engine.dispose()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(eventReqs.filter((r) => r.url.includes("directory=")).every((r) => r.signal?.aborted), "directory SSE aborted on dispose")
})

test("directory-scoped sessions: prompt waits on scoped status polling, not unscoped", async () => {
  // 实测：目录作用域会话的 busy 态只出现在 /session/status?directory= 上，无作用域状态恒为 idle。
  let scopedPolls = 0
  let unscopedPolls = 0
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes("/event")) return new Response("{}", { status: 200 })
    if (u.endsWith("/session?directory=%2Ftmp%2FdirS") && init.method === "POST") {
      return new Response(JSON.stringify({ id: "ses_scope1" }), { status: 200 })
    }
    if (u.includes("/ses_scope1/prompt_async")) return new Response(null, { status: 204 })
    if (u.includes("/session/status?directory=")) {
      scopedPolls += 1
      // 前 5 次作用域轮询报 busy，之后转 idle
      const type = scopedPolls <= 5 ? "busy" : "idle"
      return new Response(JSON.stringify({ ses_scope1: { type } }), { status: 200 })
    }
    if (u.endsWith("/session/status")) {
      unscopedPolls += 1
      return new Response(JSON.stringify({ ses_scope1: { type: "idle" } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl, pollIntervalMs: 10, promptTimeoutMs: 5_000 })
  await engine.initialize()
  await engine.createSession({ title: "s", directory: "/tmp/dirS" })
  let done = false
  const promptPromise = engine.prompt("ses_scope1", { text: "hi" }).then(() => { done = true })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(done, false, "prompt still pending while scoped status reports busy")
  assert.ok(scopedPolls > 0, "scoped status was polled")
  assert.equal(unscopedPolls, 0, "unscoped status must not be relied on for a scoped session")
  await promptPromise
  assert.equal(done, true)
  assert.ok(scopedPolls >= 6, "prompt resolved only after the scoped busy -> idle transition")
  await engine.dispose()
})

test("directory-scoped sessions: deleteSession deletes via scoped path and clears the mapping", async () => {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    requests.push({ url: u, method: init.method ?? "GET" })
    if (u.includes("/event")) return new Response("{}", { status: 200 })
    if (u.endsWith("/session?directory=%2Ftmp%2FdirD") && init.method === "POST") {
      return new Response(JSON.stringify({ id: "ses_del1" }), { status: 200 })
    }
    if (u.endsWith("/session") && init.method === "POST") return new Response(JSON.stringify({ id: "ses_del2" }), { status: 200 })
    if (u.endsWith("/session/status")) return new Response(JSON.stringify({}), { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl })
  await engine.initialize()
  try {
    await engine.createSession({ title: "d", directory: "/tmp/dirD" }) // 映射会话
    await engine.createSession({ title: "p" }) // 未映射会话

    // 删除前：映射存在，listSessionStatuses 会补拉该目录的作用域 status
    requests.length = 0
    await engine.listSessionStatuses()
    assert.ok(requests.some((r) => r.url.includes("/session/status?directory=%2Ftmp%2FdirD")), "scoped status fetched while mapping exists")

    await engine.deleteSession("ses_del1")
    // 映射会话的 DELETE 路径带 directory 查询参数
    assert.ok(
      requests.some((r) => r.url.endsWith("/session/ses_del1?directory=%2Ftmp%2FdirD") && r.method === "DELETE"),
      "DELETE issued on the scoped path for a mapped session"
    )

    // 删除后：映射已清理，listSessionStatuses 不再对该目录发作用域 status 请求
    requests.length = 0
    await engine.listSessionStatuses()
    assert.ok(!requests.some((r) => r.url.includes("/session/status?directory=")), "no scoped status fetch once the mapping is cleared")

    // 未映射会话的 DELETE 路径保持无 query
    await engine.deleteSession("ses_del2")
    const del2 = requests.find((r) => r.method === "DELETE")
    assert.ok(del2, "DELETE issued for the unmapped session")
    assert.ok(del2.url.endsWith("/session/ses_del2") && !del2.url.includes("?"), "no directory query for an unmapped session")
  } finally {
    // dispose 必须始终执行：断言失败时 SSE 泵的轮询定时器会挂住测试进程
    await engine.dispose()
  }
})

test("directory-scoped sessions: listSessionStatuses merges scoped statuses over unscoped", async () => {
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes("/event")) return new Response("{}", { status: 200 })
    if (u.endsWith("/session?directory=%2Ftmp%2FdirX") && init.method === "POST") {
      return new Response(JSON.stringify({ id: "ses_x1" }), { status: 200 })
    }
    if (u.endsWith("/session/status")) {
      // 无作用域视图：把作用域会话误报为 idle（实测行为）
      return new Response(JSON.stringify({ plainSes: { type: "idle" }, ses_x1: { type: "idle" } }), { status: 200 })
    }
    if (u.includes("/session/status?directory=")) {
      return new Response(JSON.stringify({ ses_x1: { type: "busy" } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  const engine = createOpenCodeEngine({ manageHost: false, fetchImpl })
  await engine.initialize()
  await engine.createSession({ title: "x", directory: "/tmp/dirX" })
  const statuses = await engine.listSessionStatuses()
  // 合并结果同时含无作用域会话与作用域会话，且作用域视图（busy）覆盖无作用域误报（idle）
  assert.deepEqual(statuses, { plainSes: { type: "idle" }, ses_x1: { type: "busy" } })
  await engine.dispose()
})
