# 网关接口规范（通用版 1.2）兼容改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关会话创建满足《网关接口规范_通用-1.2》（title 可选、directory 从 body 读取），OpenCode 引擎实现会话目录作用域（请求注入 + SSE 按目录分路订阅）。

**Architecture:** 网关层（gateway-server.js）只改 POST /session 的入参解析；引擎层（opencode-engine.js）在**已有的** `?directory=` 建会话机制（createSession 现已支持）之上补三件事：目录映射表、会话级请求的 directory 注入、每目录一条 SSE 订阅（与现有无作用域订阅共用同一泵函数）。OMP/PI 引擎不动。

**Tech Stack:** Node.js ≥20、纯 ESM、零 npm 依赖、`node --test`。

**Spec:** `docs/superpowers/specs/2026-09-03-gateway-spec-v12-compat-design.md`

## Global Constraints

- 工作目录：主检出 `/Users/lzzd/project/Multi-AgentEngine-Gateway`，分支 `feature/spec-v12-compat`——**不建工作树**（用户明确偏好）
- node 不在默认 PATH，任何 node 命令前先 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`
- 网关核心只允许 `node:` 与 `./` 导入（import 边界测试强制）
- 无 directory 的会话行为零变化（回归保障：现有 147 测试全绿）
- 全局 `/session/status` 轮询保持无作用域（规格 §3.2，实测可命中目录作用域会话）
- 测试命令：`cd bridge && node --test`（全量）/ `node --test test/<file>`（单文件）；基线 147
- commit 信息中文，前缀 `feat:`/`test:`

---

### Task 1: POST /session 兼容通用规范（title 可选 + directory 从 body 读取）

**Files:**
- Modify: `bridge/src/gateway/gateway-server.js`（POST /session 处理器，约 51-60 行）
- Test: `bridge/test/gateway-server-sessions.test.js`

**Interfaces:**
- Consumes: 无（现有 `engine.createSession({ title, directory })` 签名不变）
- Produces: `POST /session` 接受 body `{title?, directory?}`——title 缺失/非字符串/空白时网关生成 `会话-<yyyyMMdd-HHmmss>` 并回填响应；directory 优先取 body（非空字符串），回落 URL query；响应仍为 `{id, title, created_at, status:"idle"}`

- [ ] **Step 1: 替换旧断言 + 写失败测试**

先读 `bridge/test/gateway-server-sessions.test.js`，**删除**第 52-60 行的旧测试（"missing title returns the spec validation error"——它断言旧行为），然后在文件末尾追加：

```js
test("session create: title optional with generated default (universal spec 1.2)", async () => {
  const response = await fetch(server.url + "/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
  })
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.ok(session.id, "id returned")
  assert.match(session.title, /^会话-\d{4}\d{2}\d{2}-\d{6}$/)
  assert.equal(session.status, "idle")
  assert.ok(session.created_at)
})

test("session create: blank and non-string titles also generate defaults", async () => {
  for (const title of ["", "   "]) {
    const response = await fetch(server.url + "/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title })
    })
    assert.equal(response.status, 200)
    assert.match((await response.json()).title, /^会话-/)
  }
})

test("session create: directory read from body (universal spec 1.2)", async () => {
  const response = await fetch(server.url + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "/tmp/spec-v12-dir" })
  })
  assert.equal(response.status, 200)
  assert.ok((await response.json()).id)
  // fake engine 断言 createSession 收到 directory
  const calls = engine.createdSessions
  assert.equal(calls.at(-1).directory, "/tmp/spec-v12-dir")
  assert.ok(calls.at(-1).title, "generated title passed through")
})

test("session create: body directory wins over query, query still works without body", async () => {
  await fetch(server.url + "/session?directory=/tmp/from-query", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "q" })
  })
  assert.equal(engine.createdSessions.at(-1).directory, "/tmp/from-query")
  await fetch(server.url + "/session?directory=/tmp/from-query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "b", directory: "/tmp/from-body" })
  })
  assert.equal(engine.createdSessions.at(-1).directory, "/tmp/from-body")
})
```

**注意**：先读该测试文件顶部的测试脚手架（server/engine fake 的构造方式，`engine.createdSessions` 是否已存在——若 fake engine 未记录 createSession 参数，需在 fake 里补一行记录，遵循现有 fake 的写法）。`会话-` 前缀断言里的 `\d{6}` 是 HHmmss 六位数字。

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-server-sessions.test.js`
Expected: FAIL——无 title 时 400（旧校验仍在）、body directory 被忽略

- [ ] **Step 3: 实现（gateway-server.js POST /session 处理器替换）**

```js
      if (method === "POST" && path === "/session") {
        const body = await readBody(request)
        // 通用规范 1.2：title 可选（缺省自动生成）；directory 在 body（query 为兼容回落）
        const rawTitle = typeof body.title === "string" ? body.title.trim() : ""
        const title = rawTitle || `会话-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14).replace(/^(\d{8})(\d{6})$/, "$1-$2")}`
        const bodyDirectory = typeof body.directory === "string" && body.directory.trim() ? body.directory : undefined
        const directory = bodyDirectory ?? url.searchParams.get("directory") ?? undefined
        const { id } = await engine.createSession({ title, directory })
        const record = registry.register({ id, title })
        return writeJSON(response, 200, record)
      }
```

（时间戳格式：`20260903-142530` 形态，与测试断言 `^会话-\d{8}-\d{6}$` 一致；上面 toISOString 链先去符号取 14 位再插横线，等价实现可自选但必须满足该正则。）

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-server-sessions.test.js`
Expected: PASS

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd bridge && node --test`
Expected: 147 - 1（删掉的旧断言）+ 4 新增 = 150 全绿。若 `gateway-spec-conformance.test.js` 或其他测试因 title 行为变化失败，按新规范语义修正该断言（title 可选）。

```bash
git add bridge/src/gateway/gateway-server.js bridge/test/gateway-server-sessions.test.js
git commit -m "feat: 会话创建兼容通用规范 1.2（title 可选、directory 从 body 读取）"
```

---

### Task 2: OpenCode 引擎目录作用域（映射 + 请求注入 + SSE 分路）

**Files:**
- Modify: `bridge/src/gateway/engines/opencode-engine.js`
- Test: `bridge/test/gateway-opencode-engine.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createSession({title, directory})` 调用（签名未变）；引擎现有 `request/requestJSON/pumpEventStream` 内部函数
- Produces: 引擎对外接口不变；内部新增行为——
  - `sessionDirectories: Map<sessionID, absDirectory>`（`path.resolve(directory)` 归一，仅 engine 内部）
  - `createSession` 有 directory 时记录映射（`?directory=` 查询已存在于现行代码）
  - `prompt`/`abort`/`listMessages` 对有映射的会话在请求路径追加 `?directory=<encodeURIComponent(已归一目录)>`（`stop` 回落路径同样注入）
  - SSE：`directoryStreams: Map<absDirectory, AbortController>`；`createSession` 记录映射后调用 `ensureDirectoryStream(dir)`——若无条目则建控制器并启动 `pumpEventStream(signal, "/event?directory=...")`；`dispose()` abort 全部目录控制器
  - `pumpEventStream(signal, eventPath = "/event")`：第二参数为 SSE 路径，解析/过滤/emit 逻辑与现状完全一致

- [ ] **Step 1: 写失败测试（追加到 gateway-opencode-engine.test.js，先读现有 fake fetch 的构造模式）**

```js
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
```

（`/tmp/dirB` 与 `/tmp/dirB/` 归一化断言依赖 `path.resolve`；`prompt` 调用里的 status 轮询在第一个测试的 fake 已覆盖。若现有测试文件的 fake 模式与此不同，遵循现有模式改写。）

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-opencode-engine.test.js`
Expected: FAIL——prompt/message 未注入 directory、无目录 SSE 订阅

- [ ] **Step 3: 实现（opencode-engine.js）**

1）import 区与构造区新增（文件顶部已有 `ManagedOpenCodeHost` 导入；加 `path`）：

```js
import path from "node:path"
```

引擎闭包内（`let managedHost` 附近）新增：

```js
  const sessionDirectories = new Map()
  const directoryStreams = new Map()
```

2）`pumpEventStream` 增加路径参数（函数签名与 fetch 行改两处，其余不动）：

```js
  async function pumpEventStream(signal, eventPath = "/event") {
    while (running) {
      try {
        const response = await fetchImpl(`${base}${eventPath}`, { headers: { Authorization: authorization }, signal })
```

3）新增目录流管理（放在 pumpEventStream 之后）：

```js
  // 通用规范 1.2：目录作用域会话的事件只出现在 /event?directory=<dir> 流上（实测确认），
  // 默认无作用域流收不到；因此每个目录首会话补一条订阅，事件并入同一 emit 分发。
  function ensureDirectoryStream(directory) {
    if (directoryStreams.has(directory)) return
    const controller = new AbortController()
    directoryStreams.set(directory, controller)
    void pumpEventStream(controller.signal, `/event?directory=${encodeURIComponent(directory)}`)
  }
```

4）`createSession` 记录映射并开流（替换现有函数体）：

```js
    async createSession({ title, directory } = {}) {
      const normalized = typeof directory === "string" && directory.trim() ? path.resolve(directory) : undefined
      const query = normalized ? `?directory=${encodeURIComponent(normalized)}` : ""
      const session = await requestJSON(`/session${query}`, {
        method: "POST",
        body: JSON.stringify({ title: title ?? "session" })
      })
      if (typeof session?.id !== "string") throw engineUnavailable("OpenCode createSession returned no id")
      if (normalized) {
        sessionDirectories.set(session.id, normalized)
        ensureDirectoryStream(normalized)
      }
      return { id: session.id }
    },
```

5）会话级请求注入（新增辅助函数 + 三个方法改造）：

```js
  function scopedPath(sessionID, suffix) {
    const directory = sessionDirectories.get(sessionID)
    const base = `/session/${encodeURIComponent(sessionID)}${suffix}`
    return directory ? `${base}?directory=${encodeURIComponent(directory)}` : base
  }
```

`prompt` 中两处路径替换：`request(scopedPath(sessionID, "/prompt_async"), {...})`；`abort` 中 `/abort` 与 `/stop` 两处同样替换为 `scopedPath(sessionID, "/abort")` / `scopedPath(sessionID, "/stop")`；`listMessages` 中替换为 `requestJSON(scopedPath(sessionID, "/message"))`。

6）`dispose` 清理目录流（替换现有函数体）：

```js
    async dispose() {
      running = false
      for (const controller of directoryStreams.values()) controller.abort()
      directoryStreams.clear()
      managedHost?.stop()
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-opencode-engine.test.js`
Expected: PASS

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd bridge && node --test`
Expected: 全绿（150 + 3 新增 = 153）

```bash
git add bridge/src/gateway/engines/opencode-engine.js bridge/test/gateway-opencode-engine.test.js
git commit -m "feat: OpenCode 引擎会话目录作用域（请求注入 + SSE 按目录分路）"
```

---

### Task 3: 回归验证与实测冒烟

**Files:**
- 无代码改动；产出 `docs/superpowers/plans/2026-09-03-gateway-spec-v12-compat-run-notes.md`

**Interfaces:**
- Consumes: Task 1/2 的全部行为。

- [ ] **Step 1: 无 key 结构验证（子代理执行）**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /Users/lzzd/project/Multi-AgentEngine-Gateway && cd bridge && node --test   # 153 全绿
# 网关无 key 冒烟：默认发现配置启动，验证无 title 创建 + directory 透传（body）
node ../bridge/src/gateway/main.js --engine opencode --port 6217 &   # 需 ZAI_API_KEY=x（模型不会调用）
curl -s -X POST localhost:6217/session -H 'Content-Type: application/json' -d '{"directory":"/tmp/v12-smoke"}'
# 断言：200、title 形如 会话-…、status idle；杀网关
```

- [ ] **Step 2: 真实 key 目录隔离冒烟（控制器执行，key 不进子代理）**

```bash
export ZAI_API_KEY=<控制器持有>
mkdir -p /tmp/v12-dirA /tmp/v12-dirB
node bridge/src/gateway/main.js --engine opencode --port 6217 &
# 经网关（非裸 opencode API）：
# 1) POST /session {"directory":"/tmp/v12-dirA"}（无 title）→ 记 id
# 2) SSE 后台收流；POST prompt_async "在当前工作目录创建 a.txt 内容 ok"
# 3) 等 SSE session.idle；断言 /tmp/v12-dirA/a.txt 存在、SSE 收到 message.part.updated
# 4) 同法第二会话绑 /tmp/v12-dirB → b.txt 落 dirB；两目录互不串扰
# 5) rehearsal（默认目录）10/10 回归
```

- [ ] **Step 3: run-notes + 提交**

```bash
git add docs/superpowers/plans/2026-09-03-gateway-spec-v12-compat-run-notes.md
git commit -m "docs: 通用规范 1.2 兼容实测记录"
```

---

## Self-Review 结论

- **Spec coverage**：规格 §3.1 → Task 1；§3.2 的映射/注入/SSE 分路 → Task 2；§5 测试矩阵 → Task 1/2 单测 + Task 3 冒烟（无 key 子代理 + 真实 key 控制器分工与规格一致）；§4 错误处理中"目录不存在不预检"（设计决定，无代码）；§6 非目标未越界。
- **Placeholder scan**：Task 3 Step 2 的命令带中文注释描述步骤（冒烟由控制器人肉执行，非子代理代码任务，可接受）；其余步骤均含完整代码。
- **Type consistency**：`scopedPath(sessionID, suffix)` 在 prompt/abort/listMessages 三处用法一致；`ensureDirectoryStream(directory)` 与 `directoryStreams` 键均为 `path.resolve` 归一后的绝对路径；测试断言的 URL 编码（`%2Ftmp%2FdirA`）与 `encodeURIComponent` 输出一致。
