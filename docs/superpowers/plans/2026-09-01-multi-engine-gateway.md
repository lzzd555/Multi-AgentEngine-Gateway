# 多引擎可替换 Agent 网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 bridge/src/gateway/ 新建赛题网关，精确实现《Agent 网关接口规范》，通过 EngineAdapter 适配器接口接入 OpenCode / OMP / PI 三种引擎，`--engine` 启动参数切换，交付 solution.zip。

**Architecture:** 网关核心（路由/SSE/会话表/交互队列/消息规范化）零 bridge 依赖，只依赖 `engines/` 下两个适配器（opencode-engine 代理 OpenCode HTTP+SSE；acp-engine 包装 AcpService/AcpClient）。bridge 侧唯一行为性修改是 AcpClient 支持注入权限挂起处理器。

**Tech Stack:** Node.js ≥20（ACP 适配器路径需 22+），纯 ESM，零 npm 依赖（只用 node: 内置模块），`node --test` 测试。

**Spec:** `docs/superpowers/specs/2026-09-01-multi-engine-gateway-design.md`（设计与决策依据）；接口契约原文 `Agent 网关接口规范.md`。

## Global Constraints

- 只用 Node 内置模块（`node:http`、`node:crypto`、`node:events`、`node:stream`、`node:child_process`、`node:path`、`node:url`、`node:fs/promises`），**禁止新增任何 npm 依赖**。
- 网关核心文件（`bridge/src/gateway/*.js` 根目录）**禁止 import gateway/ 之外的 bridge 模块**；只有 `bridge/src/gateway/engines/*.js` 允许 `../../` 相对导入。Task 5 的 import 边界测试强制执行。
- 每个任务收尾必须跑 `npm --prefix bridge test` 全绿（既有 83 个测试文件不得回归）。
- 规范保真：路径、状态码、事件名、错误码逐字取自 `Agent 网关接口规范.md`（端口 6217；事件 `server.connected`/`server.heartbeat`(15s)/`session.status`/`session.idle`/`session.error`/`message.part.updated`/`question.asked`/`permission.asked`；错误码 `VALIDATION_ERROR`/`NOT_FOUND`/`INTERNAL_ERROR`/`BAD_GATEWAY`/`SERVICE_UNAVAILABLE`）。
- 网关无鉴权（不引入 `http-policy.js` 的 `authenticateDaemonRequest`），默认绑定 `localhost`。
- Windows 兼容：新代码不使用 Unix-only API（信号名、pty、`process.kill` 到 POSIX 信号只出现在继承的 bridge 代码里）。
- 提交信息用 conventional commits（`feat(gateway): ...` / `fix(gateway): ...` / `docs: ...`）。
- 共享事件形状：引擎与总线的事件一律为 `{ type: string, properties: object }`，SSE 帧为 `data: {JSON}\n\n`。

---

## Milestone M1：网关骨架 + OpenCode 引擎

### Task 1: 网关启动参数解析 `options.js`

**Files:**
- Create: `bridge/src/gateway/options.js`
- Test: `bridge/test/gateway-options.test.js`

**Interfaces:**
- Produces: `parseGatewayOptions(args: string[], environment?: object) → { engine: string, host: string, port: number, defaultModel: string, help?: boolean }`；`gatewayUsage() → string`

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-options.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseGatewayOptions, gatewayUsage } from "../src/gateway/options.js"

test("defaults match the gateway spec", () => {
  const options = parseGatewayOptions([], {})
  assert.equal(options.engine, "opencode")
  assert.equal(options.host, "localhost")
  assert.equal(options.port, 6217)
  assert.equal(options.defaultModel, "zai/glm-5.2")
})

test("--engine and --port args win over environment", () => {
  const options = parseGatewayOptions(["--engine", "pi", "--port", "7000"], { ENGINE: "omp" })
  assert.equal(options.engine, "pi")
  assert.equal(options.port, 7000)
})

test("environment variables set engine and model", () => {
  const options = parseGatewayOptions([], { ENGINE: "omp", GATEWAY_DEFAULT_MODEL: "zai/glm-5.2-air" })
  assert.equal(options.engine, "omp")
  assert.equal(options.defaultModel, "zai/glm-5.2-air")
})

test("HARNESS_REMOTE_BACKEND is honored as a fallback", () => {
  assert.equal(parseGatewayOptions([], { HARNESS_REMOTE_BACKEND: "pi" }).engine, "pi")
})

test("invalid port and unknown option are rejected", () => {
  assert.throws(() => parseGatewayOptions(["--port", "70000"], {}), /between 1 and 65535/)
  assert.throws(() => parseGatewayOptions(["--wat"], {}), /Unknown option/)
})

test("usage mentions engine and port", () => {
  assert.match(gatewayUsage(), /--engine/)
  assert.match(gatewayUsage(), /6217/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-options.test.js`
Expected: FAIL（`Cannot find module '../src/gateway/options.js'`）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/options.js
function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

function parsePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }
  return port
}

export function parseGatewayOptions(args, environment = process.env) {
  const options = {
    engine: environment.ENGINE ?? environment.HARNESS_REMOTE_BACKEND ?? "opencode",
    host: environment.GATEWAY_HOST ?? "localhost",
    port: parsePort(environment.GATEWAY_PORT ?? "6217"),
    defaultModel: environment.GATEWAY_DEFAULT_MODEL ?? "zai/glm-5.2"
  }
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--engine":
        options.engine = requireValue(args, index, "--engine")
        index += 1
        break
      case "--host":
        options.host = requireValue(args, index, "--host")
        index += 1
        break
      case "--port":
        options.port = parsePort(requireValue(args, index, "--port"))
        index += 1
        break
      case "--model":
        options.defaultModel = requireValue(args, index, "--model")
        index += 1
        break
      case "--help":
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${args[index]}`)
    }
  }
  return options
}

export function gatewayUsage() {
  return [
    "Usage: harness-gateway [options]",
    "",
    "Options:",
    "  --engine <name>   Agent engine: opencode, omp, pi (env ENGINE; default opencode)",
    "  --host <host>     Bind host (default localhost)",
    "  --port <port>     Bind port (default 6217)",
    "  --model <id>      Default model wire name (default zai/glm-5.2)"
  ].join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-options.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/options.js bridge/test/gateway-options.test.js
git commit -m "feat(gateway): add startup options parsing"
```

---

### Task 2: SSE 事件总线 `event-bus.js`

**Files:**
- Create: `bridge/src/gateway/event-bus.js`
- Test: `bridge/test/gateway-event-bus.test.js`

**Interfaces:**
- Produces: `createEventBus({ heartbeatMs?, setIntervalImpl?, clearIntervalImpl? }) → { emit(event: {type, properties}), subscribe(listener) → unsubscribe, handle(request, response) }`。`handle` 写 SSE 头（`text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`），连接后立即写 `server.connected`，每 `heartbeatMs`(默认 15000) 写 `server.heartbeat`，客户端断开时清理。

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-event-bus.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { createEventBus } from "../src/gateway/event-bus.js"

function fakeResponse() {
  const response = new PassThrough()
  response.headers = {}
  response.writeHead = (status, headers) => {
    response.statusCode = status
    Object.assign(response.headers, headers)
  }
  return response
}

function frames(stream) {
  const chunks = []
  stream.on("data", (chunk) => {
    for (const line of String(chunk).split("\n\n")) {
      if (line.startsWith("data: ")) chunks.push(JSON.parse(line.slice(6)))
    }
  })
  return chunks
}

test("connection emits server.connected immediately and heartbeats on the interval", async () => {
  const timers = new Map()
  const bus = createEventBus({
    heartbeatMs: 20,
    setIntervalImpl: (fn, ms) => { const id = Symbol("timer"); timers.set(id, { fn, ms }); return id },
    clearIntervalImpl: (id) => timers.delete(id)
  })
  const response = fakeResponse()
  const seen = frames(response)
  bus.handle({ on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen[0].type, "server.connected")
  assert.deepEqual(seen[0].properties, {})
  const timer = [...timers.values()][0]
  assert.equal(timer.ms, 20)
  timer.fn()
  assert.equal(seen[1].type, "server.heartbeat")
})

test("emit forwards spec-shaped events to all connections", async () => {
  const bus = createEventBus({ heartbeatMs: 60_000 })
  const response = fakeResponse()
  const seen = frames(response)
  bus.handle({ on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  bus.emit({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.at(-1).type, "session.status")
  assert.equal(seen.at(-1).properties.sessionID, "s1")
})

test("response close clears the heartbeat timer", () => {
  const cleared = []
  const bus = createEventBus({
    heartbeatMs: 1000,
    setIntervalImpl: () => 1,
    clearIntervalImpl: (id) => cleared.push(id)
  })
  const request = new EventEmitter()
  const response = fakeResponse()
  bus.handle(request, response)
  request.emit("close")
  assert.deepEqual(cleared, [1])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-event-bus.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/event-bus.js
const DEFAULT_HEARTBEAT_MS = 15_000

export function createEventBus({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  const connections = new Set()

  function emit(event) {
    for (const write of [...connections]) {
      try {
        write(event)
      } catch {
        // a dead connection is cleaned up by its own close handler
      }
    }
  }

  function subscribe(listener) {
    const forward = (event) => listener(event)
    connections.add(forward)
    return () => connections.delete(forward)
  }

  function handle(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })
    const write = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
    write({ type: "server.connected", properties: {} })
    connections.add(write)
    const timer = setIntervalImpl(() => write({ type: "server.heartbeat", properties: {} }), heartbeatMs)
    request.on("close", () => {
      clearIntervalImpl(timer)
      connections.delete(write)
    })
  }

  return { emit, subscribe, handle }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-event-bus.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/event-bus.js bridge/test/gateway-event-bus.test.js
git commit -m "feat(gateway): add SSE event bus with spec heartbeat"
```

---

### Task 3: 会话登记表 `session-registry.js`

**Files:**
- Create: `bridge/src/gateway/session-registry.js`
- Test: `bridge/test/gateway-session-registry.test.js`

**Interfaces:**
- Produces: `createSessionRegistry({ now? }) → { register({id, title}) → record, get(id) → record|undefined, setStatus(id, "idle"|"busy"), statuses() → { [id]: {type} }, remove(id), has(id) }`；record = `{ id, title, created_at, status }`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-session-registry.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/session-registry.js
export function createSessionRegistry({ now = () => new Date().toISOString() } = {}) {
  const sessions = new Map()
  return {
    register({ id, title }) {
      const record = { id, title: title ?? id, created_at: now(), status: "idle" }
      sessions.set(id, record)
      return record
    },
    get(id) {
      return sessions.get(id)
    },
    has(id) {
      return sessions.has(id)
    },
    setStatus(id, status) {
      const record = sessions.get(id)
      if (record) record.status = status
    },
    statuses() {
      return Object.fromEntries([...sessions.values()].map((record) => [record.id, { type: record.status }]))
    },
    remove(id) {
      sessions.delete(id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-session-registry.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/session-registry.js bridge/test/gateway-session-registry.test.js
git commit -m "feat(gateway): add session registry"
```

---

### Task 4: 交互挂起队列 `interaction-queue.js`

**Files:**
- Create: `bridge/src/gateway/interaction-queue.js`
- Test: `bridge/test/gateway-interaction-queue.test.js`

**Interfaces:**
- Produces: `createInteractionQueue({ now? }) → { addQuestion(sessionID, questions) → { id, settled: Promise<{answers}> }, addPermission(sessionID, permission, patterns) → { id, settled: Promise<{reply, message?}> }, listQuestions() → records, listPermissions() → records, resolveQuestion(id, answers) → boolean, resolvePermission(id, reply) → boolean }`；record 形如规范 §5.1/§5.3（`{ id, sessionID, questions|{permission, patterns}, created_at }`），已解决的条目不再出现在 list 中。

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-interaction-queue.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/interaction-queue.js
import { randomUUID } from "node:crypto"

export function createInteractionQueue({ now = () => new Date().toISOString() } = {}) {
  const entries = new Map()

  function add(kind, sessionID, payload) {
    const id = `req_${randomUUID().slice(0, 8)}`
    let resolveSettled
    const settled = new Promise((resolve) => { resolveSettled = resolve })
    entries.set(id, {
      kind,
      done: false,
      record: { id, sessionID, ...payload, created_at: now() },
      resolveSettled
    })
    return { id, settled }
  }

  function list(kind) {
    return [...entries.values()].filter((entry) => entry.kind === kind && !entry.done).map((entry) => entry.record)
  }

  function resolveEntry(id, answer) {
    const entry = entries.get(id)
    if (!entry || entry.done) return false
    entry.done = true
    entry.resolveSettled(answer)
    return true
  }

  return {
    addQuestion(sessionID, questions) {
      return add("question", sessionID, { questions })
    },
    addPermission(sessionID, permission, patterns) {
      return add("permission", sessionID, { permission, patterns })
    },
    listQuestions() {
      return list("question")
    },
    listPermissions() {
      return list("permission")
    },
    resolveQuestion(id, answers) {
      return resolveEntry(id, { answers })
    },
    resolvePermission(id, { reply, message } = {}) {
      return resolveEntry(id, { reply, message })
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-interaction-queue.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/interaction-queue.js bridge/test/gateway-interaction-queue.test.js
git commit -m "feat(gateway): add question/permission interaction queue"
```

---

### Task 5: EngineAdapter 契约 + 工厂 + import 边界测试

**Files:**
- Create: `bridge/src/gateway/engines/engine-adapter.js`
- Test: `bridge/test/gateway-engine-adapter.test.js`, `bridge/test/gateway-import-boundary.test.js`

**Interfaces:**
- Produces: `createEngine(id: string, options?: object) → Engine`。Engine 契约（JSDoc 记录在文件头）：
  - `id: string`、`label: string`、`capabilities: { questions, permissions, abort }`
  - `initialize() → Promise<void>`、`dispose() → Promise<void>`
  - `createSession({ title, directory? }) → Promise<{ id }>`
  - `deleteSession(id) → Promise<void>`
  - `listSessionStatuses() → Promise<{ [id]: { type } }>`
  - `prompt(id, { text, model }) → Promise<void>`（阻塞到本轮完成；引擎不可用错误带 `error.code === "ENGINE_UNAVAILABLE"`）
  - `abort(id) → Promise<void>`
  - `listMessages(id) → Promise<NormalizedMessage[]>`
  - `subscribe(listener: (event: {type, properties}) => void) → unsubscribe`
  - `listQuestions() → Promise<records>`、`replyQuestion(id, answers) → Promise<void>`
  - `listPermissions() → Promise<records>`、`replyPermission(id, { reply, message }) → Promise<void>`
- 本任务工厂只注册 `opencode`（Task 13 加入 omp/pi）。未知 id 抛 `Unknown engine: <id>. Available: opencode`。

- [ ] **Step 1: Write the failing tests**

```js
// bridge/test/gateway-engine-adapter.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createEngine } from "../src/gateway/engines/engine-adapter.js"

test("unknown engine id is rejected with the available list", () => {
  assert.throws(() => createEngine("nope"), /Unknown engine: nope\. Available: opencode/)
})
```

```js
// bridge/test/gateway-import-boundary.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const gatewayRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "gateway")

test("gateway core never imports outside the gateway package", () => {
  const coreFiles = readdirSync(gatewayRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  assert.ok(coreFiles.length > 0, "gateway core files must exist")
  for (const entry of coreFiles) {
    const source = readFileSync(path.join(gatewayRoot, entry.name), "utf8")
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])
    for (const specifier of imports) {
      const isBuiltin = specifier.startsWith("node:")
      const isLocal = specifier.startsWith("./")
      assert.ok(
        isBuiltin || isLocal,
        `${entry.name} imports "${specifier}" — gateway core may only use node: builtins and ./ relative imports`
      )
    }
  }
})

test("engine adapters stay inside the engines directory for bridge imports", () => {
  const enginesRoot = path.join(gatewayRoot, "engines")
  for (const entry of readdirSync(enginesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    const source = readFileSync(path.join(enginesRoot, entry.name), "utf8")
    for (const specifier of [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])) {
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("./") || specifier === "../../opencode-host.js",
        `${entry.name} imports "${specifier}" — engines may only import node:, ./ or the documented bridge drivers`
      )
    }
  }
})
```

注意：第二个测试的允许清单在 Task 13 会扩展为 `../../acp-service.js`、`../../acp-client.js`、`../../harness-profiles.js`、`../../config.js`（在 Task 13 的步骤里同步更新断言），本任务先按上面内容写入。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix bridge test -- test/gateway-engine-adapter.test.js test/gateway-import-boundary.test.js`
Expected: FAIL（engines/engine-adapter.js 不存在）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/engines/engine-adapter.js
// EngineAdapter — the gateway's single engine seam. The gateway core knows engines only
// through this contract; every engine difference lives behind it.
//
// Engine = {
//   id, label, capabilities: { questions, permissions, abort },
//   initialize() → Promise<void>, dispose() → Promise<void>,
//   createSession({ title, directory? }) → Promise<{ id }>,
//   deleteSession(id) → Promise<void>,
//   listSessionStatuses() → Promise<{ [id]: { type: "idle"|"busy" } }>,
//   prompt(id, { text, model }) → Promise<void>,   // blocks until the turn finishes
//   abort(id) → Promise<void>,
//   listMessages(id) → Promise<NormalizedMessage[]>,
//   subscribe(listener) → unsubscribe,              // emits { type, properties } spec events only
//   listQuestions() → Promise<records>, replyQuestion(id, answers) → Promise<void>,
//   listPermissions() → Promise<records>, replyPermission(id, { reply, message }) → Promise<void>
// }
// Engine-unreachable failures reject with an Error carrying code "ENGINE_UNAVAILABLE".
import { createOpenCodeEngine } from "./opencode-engine.js"

export function createEngine(id, options = {}) {
  switch (id) {
    case "opencode":
      return createOpenCodeEngine(options)
    default:
      throw new Error(`Unknown engine: ${id}. Available: opencode`)
  }
}
```

（此时 import boundary 测试会因为 `opencode-engine.js` 尚不存在而失败——本任务 Step 3 需要连带创建一个最小 `opencode-engine.js` 骨架，只包含 `createOpenCodeEngine` 导出与 capabilities 常量，方法在 Task 7 填充；骨架文件内容如下，作为 Step 3b。）

```js
// bridge/src/gateway/engines/opencode-engine.js（Task 5 的最小骨架，Task 7 完成全部方法）
import { ManagedOpenCodeHost } from "../../opencode-host.js"

export const OPENCODE_CAPABILITIES = { questions: true, permissions: true, abort: true }

export function createOpenCodeEngine(options = {}) {
  const listeners = new Set()
  return {
    id: "opencode",
    label: "OpenCode",
    capabilities: OPENCODE_CAPABILITIES,
    initialize: async () => {},
    dispose: async () => {},
    createSession: async ({ title, directory } = {}) => { throw new Error("not implemented yet") },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
```

骨架中的 `not implemented yet` 仅存在于 Task 5→7 之间的过渡提交，Task 7 结束时全部替换为真实现（Task 7 验收步骤会断言无残留）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bridge test -- test/gateway-engine-adapter.test.js test/gateway-import-boundary.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/engines/engine-adapter.js bridge/src/gateway/engines/opencode-engine.js \
  bridge/test/gateway-engine-adapter.test.js bridge/test/gateway-import-boundary.test.js
git commit -m "feat(gateway): add EngineAdapter contract and import boundary guard"
```

---

### Task 6: 消息规范化共享层 + OpenCode 透传

**Files:**
- Create: `bridge/src/gateway/message-normalizer.js`, `bridge/src/gateway/engines/normalize-opencode.js`
- Test: `bridge/test/gateway-normalize-opencode.test.js`

**Interfaces:**
- Consumes: 规范 §4.2 的消息 schema。
- Produces:
  - `message-normalizer.js`：`normalizePart(part)`（只保留 `text`/`tool`/`step-finish`，输出规范字段名）；`isValidNormalizedMessage(message) → boolean`（conformance 测试用）
  - `normalize-opencode.js`：`normalizeOpenCodeMessages(messages: any[]) → NormalizedMessage[]`（OpenCode 原生格式即规范蓝本：校验 + 补默认 `created_at`/`info.role`，丢弃未知字段）
- NormalizedMessage（规范 §4.2）：`{ id, role: "user"|"assistant"|"tool", content, tool_calls?, tool_call_id?, tool_name?, created_at, info?: { role, finish }, parts? }`

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-normalize-opencode.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeOpenCodeMessages } from "../src/gateway/engines/normalize-opencode.js"
import { isValidNormalizedMessage } from "../src/gateway/message-normalizer.js"

const openCodeTurn = [
  { id: "msg_001", role: "user", content: "打开Outlook", created_at: "2026-08-21T10:00:00Z" },
  {
    id: "msg_002",
    role: "assistant",
    content: "好的，正在打开",
    created_at: "2026-08-21T10:00:05Z",
    tool_calls: [{ id: "call_001", name: "launch", arguments: { app: "outlook" } }],
    info: { role: "assistant", finish: "tool-calls" },
    parts: [
      { type: "text", content: "好的，正在打开" },
      { type: "tool", tool: "launch", state: { status: "completed", title: "启动完成" } },
      { type: "step-finish" }
    ]
  },
  { id: "msg_003", role: "tool", tool_call_id: "call_001", tool_name: "launch", content: "exit 0" }
]

test("opencode messages pass through with validation", () => {
  const normalized = normalizeOpenCodeMessages(openCodeTurn)
  assert.equal(normalized.length, 3)
  assert.equal(isValidNormalizedMessage(normalized[0]), true)
  assert.equal(isValidNormalizedMessage(normalized[1]), true)
  assert.equal(isValidNormalizedMessage(normalized[2]), true)
  assert.equal(normalized[1].info.finish, "tool-calls")
  assert.deepEqual(normalized[1].parts.at(-1), { type: "step-finish" })
})

test("unknown part types and malformed entries are dropped", () => {
  const normalized = normalizeOpenCodeMessages([
    { id: "a", role: "assistant", content: "hi", created_at: "2026-08-21T10:00:00Z", parts: [
      { type: "text", content: "hi" },
      { type: "snapshot" },
      { type: "step-finish" }
    ] },
    null,
    { role: "user" }
  ])
  assert.equal(normalized.length, 1)
  assert.deepEqual(normalized[0].parts, [{ type: "text", content: "hi" }, { type: "step-finish" }])
})

test("missing created_at gets a fallback timestamp", () => {
  const [normalized] = normalizeOpenCodeMessages([{ id: "a", role: "user", content: "q" }])
  assert.match(normalized.created_at, /^\d{4}-\d{2}-\d{2}T/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-normalize-opencode.test.js`
Expected: FAIL（modules not found）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/message-normalizer.js
const PART_TYPES = new Set(["text", "tool", "step-finish"])
const ROLES = new Set(["user", "assistant", "tool"])

/** Keep only spec part types with spec field names; everything else is dropped. */
export function normalizePart(part) {
  if (!part || typeof part !== "object" || !PART_TYPES.has(part.type)) return undefined
  if (part.type === "text") {
    return typeof part.content === "string" ? { type: "text", content: part.content } : undefined
  }
  if (part.type === "tool") {
    if (typeof part.tool !== "string") return undefined
    const state = part.state && typeof part.state === "object"
      ? { status: part.state.status, ...(part.state.title !== undefined ? { title: part.state.title } : {}) }
      : {}
    return { type: "tool", tool: part.tool, state }
  }
  return { type: "step-finish" }
}

/** Structural check used by the spec-conformance suite. */
export function isValidNormalizedMessage(message) {
  if (!message || typeof message !== "object") return false
  if (typeof message.id !== "string" || !ROLES.has(message.role)) return false
  if (typeof message.content !== "string") return false
  if (typeof message.created_at !== "string") return false
  if (message.role === "assistant") {
    if (!message.info || message.info.role !== "assistant") return false
    if (!["stop", "tool-calls"].includes(message.info.finish)) return false
    if (!Array.isArray(message.parts)) return false
    if (!message.parts.some((part) => part?.type === "step-finish")) return false
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) return false
  }
  if (message.role === "tool" && (typeof message.tool_call_id !== "string" || typeof message.tool_name !== "string")) return false
  return true
}
```

```js
// bridge/src/gateway/engines/normalize-opencode.js
import { normalizePart } from "../message-normalizer.js"

function fallbackTimestamp() {
  return new Date().toISOString()
}

function normalizeOne(message) {
  if (!message || typeof message !== "object" || typeof message.id !== "string") return undefined
  if (!["user", "assistant", "tool"].includes(message.role)) return undefined
  const normalized = {
    id: message.id,
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    created_at: typeof message.created_at === "string" ? message.created_at : fallbackTimestamp()
  }
  if (message.role === "assistant") {
    normalized.tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    normalized.info = {
      role: "assistant",
      finish: message.info?.finish === "tool-calls" ? "tool-calls" : "stop"
    }
    normalized.parts = (Array.isArray(message.parts) ? message.parts : [])
      .map(normalizePart)
      .filter(Boolean)
  }
  if (message.role === "tool") {
    normalized.tool_call_id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
    normalized.tool_name = typeof message.tool_name === "string" ? message.tool_name : ""
  }
  return normalized
}

/** OpenCode's native message list is the spec's blueprint: validate, default, pass through. */
export function normalizeOpenCodeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map(normalizeOne).filter(Boolean)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-normalize-opencode.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/message-normalizer.js bridge/src/gateway/engines/normalize-opencode.js \
  bridge/test/gateway-normalize-opencode.test.js
git commit -m "feat(gateway): add message normalizer and opencode passthrough"
```

---

### Task 7: OpenCode 引擎适配器（完整实现）

**Files:**
- Modify: `bridge/src/gateway/engines/opencode-engine.js`（替换 Task 5 骨架）
- Test: `bridge/test/gateway-opencode-engine.test.js`

**Interfaces:**
- Consumes: `ManagedOpenCodeHost`（`bridge/src/opencode-host.js:101`，构造参数 `{command, host, port, username, password, startTimeoutMs, waitUntilReady}`，`start()/stop()`，事件 `available`/`unavailable`）；`normalizeOpenCodeMessages`。
- Produces: `createOpenCodeEngine({ command?, host?, upstreamPort?, username?, password?, manageHost?, startTimeoutMs?, fetchImpl?, sleepImpl?, pollIntervalMs?, promptTimeoutMs? }) → Engine`（契约见 Task 5）。`manageHost: false` 时不 spawn、只代理既有上游（测试用）。

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-opencode-engine.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createOpenCodeEngine } from "../src/gateway/engines/opencode-engine.js"

// A fake upstream that mimics the opencode server API the engine proxies.
function fakeUpstream() {
  const state = { sessions: new Map(), busy: new Set(), messages: new Map(), promptResolvers: [] }
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://upstream")
    const send = (body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(body === undefined ? "" : JSON.stringify(body))
    }
    if (request.method === "GET" && url.pathname === "/session/status") {
      return send(Object.fromEntries([...state.sessions.keys()].map((id) => [id, { type: state.busy.has(id) ? "busy" : "idle" }])))
    }
    if (request.method === "POST" && url.pathname === "/session") {
      const id = `ses_${state.sessions.size + 1}`
      state.sessions.set(id, { id, title: "t" })
      state.messages.set(id, [])
      return send({ id, title: "t", created_at: "2026-09-01T10:00:00Z", status: "idle" })
    }
    const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (request.method === "POST" && promptMatch) {
      state.busy.add(promptMatch[1])
      state.messages.get(promptMatch[1])?.push({
        id: `msg_${state.messages.get(promptMatch[1]).length + 1}`,
        role: "assistant", content: "done",
        created_at: "2026-09-01T10:00:01Z",
        info: { role: "assistant", finish: "stop" },
        parts: [{ type: "text", content: "done" }, { type: "step-finish" }]
      })
      state.promptResolvers.push(() => state.busy.delete(promptMatch[1]))
      return send(undefined, 204)
    }
    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (request.method === "GET" && messageMatch) return send(state.messages.get(messageMatch[1]) ?? [])
    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (request.method === "POST" && abortMatch) { state.busy.delete(abortMatch[1]); return send({ ok: true }) }
    if (request.method === "DELETE" && url.pathname.startsWith("/session/")) {
      state.sessions.delete(url.pathname.split("/")[2])
      return send({ ok: true })
    }
    if (request.method === "GET" && url.pathname === "/question") return send([])
    if (request.method === "GET" && url.pathname === "/permission") return send([])
    send({}, 404)
  })
  return { server, state }
}

async function withFakeUpstream(run) {
  const upstream = fakeUpstream()
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve))
  const port = upstream.server.address().port
  try {
    return await run(upstream, port)
  } finally {
    upstream.server.close()
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
```

（fake upstream 的 `replyQuestion`/`replyPermission` 走 `POST /question/{id}/reply`、`POST /permission/{id}/reply`，上面 404 兜底即可让引擎不抛错——引擎对 reply 的 404 按“上游已处理/过期”处理，不抛异常。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-opencode-engine.test.js`
Expected: FAIL（骨架方法 `not implemented yet`）

- [ ] **Step 3: Write the full implementation**

```js
// bridge/src/gateway/engines/opencode-engine.js
import { ManagedOpenCodeHost } from "../../opencode-host.js"
import { normalizeOpenCodeMessages } from "./normalize-opencode.js"

export const OPENCODE_CAPABILITIES = { questions: true, permissions: true, abort: true }

const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000
const SPEC_EVENT_TYPES = new Set([
  "session.status", "session.idle", "session.error", "message.part.updated",
  "question.asked", "permission.asked"
])

function splitModel(wireName) {
  if (typeof wireName !== "string" || !wireName.includes("/")) return undefined
  const separator = wireName.indexOf("/")
  return { providerID: wireName.slice(0, separator), modelID: wireName.slice(separator + 1) }
}

const engineUnavailable = (message) => Object.assign(new Error(message), { code: "ENGINE_UNAVAILABLE" })

export function createOpenCodeEngine({
  command = process.env.OPENCODE_COMMAND ?? "opencode",
  host = "127.0.0.1",
  upstreamPort = Number(process.env.GATEWAY_OPENCODE_PORT ?? 14096),
  username = "gateway",
  password = "gateway-local",
  manageHost = true,
  startTimeoutMs = 30_000,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS
} = {}) {
  const base = `http://${host}:${upstreamPort}`
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const listeners = new Set()
  let host
  let running = false

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // listener errors must not break the engine
      }
    }
  }

  async function request(path, init = {}) {
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: authorization, ...(init.headers ?? {}) }
      })
    } catch (error) {
      throw engineUnavailable(`OpenCode upstream unreachable: ${error.message}`)
    }
    if (response.status >= 500) throw engineUnavailable(`OpenCode upstream returned HTTP ${response.status}`)
    return response
  }

  async function requestJSON(path, init) {
    const response = await request(path, init)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }

  async function waitUntilIdle(sessionID) {
    const deadline = Date.now() + promptTimeoutMs
    while (Date.now() < deadline) {
      const statuses = await requestJSON("/session/status")
      if (statuses?.[sessionID]?.type !== "busy") return
      await sleepImpl(pollIntervalMs)
    }
    throw engineUnavailable(`OpenCode prompt timed out after ${promptTimeoutMs}ms`)
  }

  // Forward the upstream SSE stream to engine listeners, keeping only spec event types.
  async function pumpEventStream(signal) {
    while (running) {
      try {
        const response = await fetchImpl(`${base}/event`, { headers: { Authorization: authorization }, signal })
        if (!response.body) throw new Error("upstream SSE has no body")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data: "))
            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6))
                if (SPEC_EVENT_TYPES.has(event?.type)) emit({ type: event.type, properties: event.properties ?? {} })
              } catch {
                // a malformed upstream frame is dropped
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
        }
      } catch {
        // retry below while running
      }
      if (running) await sleepImpl(1_000)
    }
  }

  return {
    id: "opencode",
    label: "OpenCode",
    capabilities: OPENCODE_CAPABILITIES,

    async initialize() {
      running = true
      if (manageHost) {
        host = new ManagedOpenCodeHost({ command, host, port: upstreamPort, username, password, startTimeoutMs })
        host.on("unavailable", () => emit({ type: "session.error", properties: { error: { message: "OpenCode upstream exited" } } }))
        await host.start()
      }
      void pumpEventStream(undefined)
    },

    async dispose() {
      running = false
      host?.stop()
    },

    async createSession({ title, directory } = {}) {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
      const session = await requestJSON(`/session${query}`, {
        method: "POST",
        body: JSON.stringify({ title: title ?? "session" })
      })
      if (typeof session?.id !== "string") throw engineUnavailable("OpenCode createSession returned no id")
      return { id: session.id }
    },

    async deleteSession(sessionID) {
      await request(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    },

    async listSessionStatuses() {
      return (await requestJSON("/session/status")) ?? {}
    },

    async prompt(sessionID, { text, model } = {}) {
      const modelPart = splitModel(model)
      const response = await request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: text ?? "" }],
          ...(modelPart ? { model: modelPart } : {})
        })
      })
      if (response.status !== 204 && response.status !== 200) {
        throw engineUnavailable(`OpenCode prompt_async returned HTTP ${response.status}`)
      }
      await waitUntilIdle(sessionID)
    },

    async abort(sessionID) {
      const response = await request(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" })
      if (response.status === 404) {
        await request(`/session/${encodeURIComponent(sessionID)}/stop`, { method: "POST" })
      }
    },

    async listMessages(sessionID) {
      const messages = await requestJSON(`/session/${encodeURIComponent(sessionID)}/message`)
      return normalizeOpenCodeMessages(messages)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async listQuestions() {
      return (await requestJSON("/question")) ?? []
    },

    async replyQuestion(requestID, answers) {
      await request(`/question/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers })
      })
    },

    async listPermissions() {
      return (await requestJSON("/permission")) ?? []
    },

    async replyPermission(requestID, { reply, message } = {}) {
      await request(`/permission/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply, ...(message !== undefined ? { message } : {}) })
      })
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass, and no skeleton remains**

Run: `npm --prefix bridge test -- test/gateway-opencode-engine.test.js`
Expected: PASS（2 tests）
Run: `grep -n "not implemented yet" bridge/src/gateway/ || true`
Expected: 无输出（Task 5 骨架占位已全部替换）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/engines/opencode-engine.js bridge/test/gateway-opencode-engine.test.js
git commit -m "feat(gateway): implement opencode engine adapter with blocking prompt"
```

---

### Task 8: 网关路由层 `gateway-server.js`（会话 CRUD + 状态 + 错误体）

**Files:**
- Create: `bridge/src/gateway/gateway-server.js`
- Create: `bridge/test/helpers/fake-engine.js`
- Test: `bridge/test/gateway-server-sessions.test.js`

**Interfaces:**
- Consumes: Engine 契约（Task 5）、`createEventBus`、`createSessionRegistry`、`createInteractionQueue`。
- Produces: `createGatewayServer({ engine, eventBus, registry?, interactionQueue?, defaultModel? }) → http.Server`。路由：
  - `GET /health` → 200 `{ok:true}`（自检用，非规范端点）
  - `POST /session`（body `{title}`，query `directory` 可选）→ 200 `{id,title,created_at,status:"idle"}`；title 缺失 → 400 `VALIDATION_ERROR`
  - `GET /session/status` → 200 `{[id]:{type}}`
  - `GET /session/{id}` → 200 `{id,title,created_at,status,message_count}`；未知 → 404 `NOT_FOUND`
  - `DELETE /session/{id}` → 200 `{ok:true}`
  - 所有错误响应体 `{"code":"...","message":"..."}`
- `fake-engine.js` 产出 `createFakeEngine(overrides?)`：内存版 Engine 契约实现（createSession 生成 `ses_N`、prompt 延迟可控、消息可注入），供本任务与 Task 9/10/14 测试复用。

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/helpers/fake-engine.js
import { EventEmitter } from "node:events"

export function createFakeEngine(overrides = {}) {
  const emitter = new EventEmitter()
  const sessions = new Map()
  const messages = new Map()
  const statuses = new Map()
  let counter = 0
  let promptHandler = async () => {}
  const engine = {
    id: "fake",
    label: "Fake",
    capabilities: { questions: false, permissions: false, abort: true },
    initialize: async () => {},
    dispose: async () => {},
    async createSession({ title } = {}) {
      const id = `ses_${++counter}`
      sessions.set(id, { title })
      messages.set(id, [])
      statuses.set(id, { type: "idle" })
      return { id }
    },
    async deleteSession(id) { sessions.delete(id); statuses.delete(id); messages.delete(id) },
    async listSessionStatuses() { return Object.fromEntries(statuses) },
    async prompt(id) { statuses.set(id, { type: "busy" }); await promptHandler(id); statuses.set(id, { type: "idle" }) },
    async abort(id) { statuses.set(id, { type: "idle" }) },
    async listMessages(id) { return messages.get(id) ?? [] },
    subscribe(listener) { emitter.on("event", listener); return () => emitter.off("event", listener) },
    emit(event) { emitter.emit("event", event) },
    listQuestions: async () => [],
    replyQuestion: async () => {},
    listPermissions: async () => [],
    replyPermission: async () => {},
    setMessages(id, list) { messages.set(id, list) },
    setPromptHandler(handler) { promptHandler = handler },
    ...overrides
  }
  return engine
}
```

```js
// bridge/test/gateway-server-sessions.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createGatewayServer } from "../src/gateway/gateway-server.js"
import { createEventBus } from "../src/gateway/event-bus.js"
import { createSessionRegistry } from "../src/gateway/session-registry.js"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"
import { createFakeEngine } from "./helpers/fake-engine.js"

async function startGateway(engineOptions = {}) {
  const engine = createFakeEngine(engineOptions)
  const server = createGatewayServer({
    engine,
    eventBus: createEventBus(),
    registry: createSessionRegistry(),
    interactionQueue: createInteractionQueue(),
    defaultModel: "zai/glm-5.2"
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { engine, server, base: `http://127.0.0.1:${server.address().port}` }
}

test("session create, read, status and delete follow the spec", async () => {
  const { engine, server, base } = await startGateway()
  try {
    const created = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "会话标题" })
    })
    assert.equal(created.status, 200)
    const session = await created.json()
    assert.equal(session.title, "会话标题")
    assert.equal(session.status, "idle")
    assert.match(session.created_at, /^\d{4}-/)
    engine.setMessages(session.id, [
      { id: "m1", role: "user", content: "q", created_at: "2026-09-01T10:00:00Z" },
      { id: "m2", role: "assistant", content: "a", created_at: "2026-09-01T10:00:01Z",
        info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", content: "a" }, { type: "step-finish" }] }
    ])
    const read = await (await fetch(`${base}/session/${session.id}`)).json()
    assert.equal(read.message_count, 2)
    const statuses = await (await fetch(`${base}/session/status`)).json()
    assert.deepEqual(statuses[session.id], { type: "idle" })
    const removed = await (await fetch(`${base}/session/${session.id}`, { method: "DELETE" })).json()
    assert.deepEqual(removed, { ok: true })
    assert.equal((await fetch(`${base}/session/${session.id}`)).status, 404)
  } finally {
    server.close()
  }
})

test("missing title returns the spec validation error", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: "VALIDATION_ERROR", message: "title is required" })
  } finally {
    server.close()
  }
})

test("unknown session yields the spec not-found body", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session/ses_missing`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { code: "NOT_FOUND", message: "Session not found" })
  } finally {
    server.close()
  }
})

test("malformed JSON yields 400 with error body", async () => {
  const { server, base } = await startGateway()
  try {
    const response = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops"
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-server-sessions.test.js`
Expected: FAIL（gateway-server.js 不存在）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/gateway-server.js
import { createServer } from "node:http"

function writeJSON(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}

function sendError(response, status, code, message) {
  writeJSON(response, status, { code, message })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error("request body is not valid JSON"), { statusCode: 400 }))
      }
    })
    request.on("error", reject)
  })
}

/** Engine failures map onto the spec's error table; ENGINE_UNAVAILABLE is a 502. */
function engineErrorResponse(error) {
  if (error?.code === "ENGINE_UNAVAILABLE") return [502, "BAD_GATEWAY", error.message]
  return [500, "INTERNAL_ERROR", error?.message ?? "internal error"]
}

export function createGatewayServer({
  engine,
  eventBus,
  registry,
  interactionQueue,
  defaultModel = "zai/glm-5.2"
}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://gateway")
      const path = url.pathname
      const method = request.method

      if (method === "GET" && path === "/event") return eventBus.handle(request, response)
      if (method === "GET" && path === "/health") return writeJSON(response, 200, { ok: true })

      if (method === "POST" && path === "/session") {
        const body = await readBody(request)
        if (typeof body.title !== "string" || !body.title.trim()) {
          return sendError(response, 400, "VALIDATION_ERROR", "title is required")
        }
        const directory = url.searchParams.get("directory") ?? undefined
        const { id } = await engine.createSession({ title: body.title, directory })
        const record = registry.register({ id, title: body.title })
        return writeJSON(response, 200, record)
      }

      if (method === "GET" && path === "/session/status") {
        return writeJSON(response, 200, registry.statuses())
      }

      const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(message|prompt_async|abort|stop|todo))?$/)
      if (!sessionMatch) return sendError(response, 404, "NOT_FOUND", "Not found")
      const sessionID = decodeURIComponent(sessionMatch[1])
      const action = sessionMatch[2]

      if (!action && method === "GET") {
        const record = registry.get(sessionID)
        if (!record) return sendError(response, 404, "NOT_FOUND", "Session not found")
        const messages = await engine.listMessages(sessionID)
        return writeJSON(response, 200, { ...record, message_count: messages.length })
      }

      if (!action && method === "DELETE") {
        if (!registry.has(sessionID)) return sendError(response, 404, "NOT_FOUND", "Session not found")
        await engine.deleteSession(sessionID)
        registry.remove(sessionID)
        return writeJSON(response, 200, { ok: true })
      }

      // message / prompt_async / abort / stop are implemented in the next task's continuation
      // of this router; unknown actions fall through to 404 until then.
      if (action) {
        const handled = await handleSessionAction({ request, response, url, sessionID, action, engine, registry, eventBus, interactionQueue, defaultModel })
        if (handled) return
      }
      return sendError(response, 404, "NOT_FOUND", "Not found")
    } catch (error) {
      if (error?.statusCode === 400) return sendError(response, 400, "VALIDATION_ERROR", error.message)
      const [status, code, message] = engineErrorResponse(error)
      return sendError(response, status, code, message)
    }
  })
}

async function handleSessionAction() {
  return false
}
```

（`handleSessionAction` 在 Task 9 完整实现；本任务先返回 false 走 404，测试不覆盖这些动作。）

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-server-sessions.test.js`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/gateway-server.js bridge/test/helpers/fake-engine.js bridge/test/gateway-server-sessions.test.js
git commit -m "feat(gateway): add gateway server session routes"
```

---

### Task 9: 网关路由层（prompt 阻塞 / abort / stop / message / question / permission）

**Files:**
- Modify: `bridge/src/gateway/gateway-server.js`（实现 `handleSessionAction` 与交互路由）
- Test: `bridge/test/gateway-server-actions.test.js`

**Interfaces:**
- Consumes: Task 8 的 `handleSessionAction` 挂载点与 `fake-engine.js`。
- Produces（对外行为）：
  - `POST /session/{id}/prompt_async`：body `{parts:[{type:"text",text}], model?:{providerID,modelID}, agent?}` → 先发 `session.status busy`，调 `engine.prompt`（阻塞），完成后 `session.status idle` + `session.idle` 事件，返回 **204**；`parts` 缺失或无 text → 400；会话不存在 → 404；engine 抛 `ENGINE_UNAVAILABLE` → 502。model 缺省用 `defaultModel`。
  - `GET /session/{id}/message` → 200 规范消息数组
  - `POST /session/{id}/abort` 与 `/stop` → 200 `{ok:true}`
  - `GET /question` / `POST /question/{id}/reply`：engine.capabilities.questions 为 false 时恒 `[]`，reply → 404
  - `GET /permission` / `POST /permission/{id}/reply`：经 interactionQueue；reply `once|always|reject`，其他 → 400

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-server-actions.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createGatewayServer } from "../src/gateway/gateway-server.js"
import { createEventBus } from "../src/gateway/event-bus.js"
import { createSessionRegistry } from "../src/gateway/session-registry.js"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"
import { createFakeEngine } from "./helpers/fake-engine.js"

async function startGateway({ engine = createFakeEngine() } = {}) {
  const eventBus = createEventBus()
  const server = createGatewayServer({
    engine, eventBus,
    registry: createSessionRegistry(),
    interactionQueue: createInteractionQueue(),
    defaultModel: "zai/glm-5.2"
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { engine, eventBus, server, base: `http://127.0.0.1:${server.address().port}` }
}

async function createSession(base) {
  const response = await fetch(`${base}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "t" })
  })
  return (await response.json()).id
}

test("prompt_async blocks until the engine turn finishes and emits status events", async () => {
  const { engine, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    let release
    engine.setPromptHandler(() => new Promise((resolve) => { release = resolve }))
    const seen = []
    const source = new EventSource(`${base}/event`) // Node 22+: global EventSource
    source.onmessage = (message) => seen.push(JSON.parse(message.data))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const promptPromise = fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "打开Outlook" }], model: { providerID: "zai", modelID: "glm-5.2" } })
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await Promise.race([promptPromise, Promise.resolve("pending")])), "pending") // still blocking
    release()
    const response = await promptPromise
    assert.equal(response.status, 204)
    const types = seen.map((event) => event.type)
    assert.ok(types.includes("session.status"))
    assert.ok(types.includes("session.idle"))
    const busyEvent = seen.find((event) => event.type === "session.status" && event.properties.status?.type === "busy")
    assert.ok(busyEvent, "busy status event was emitted")
    assert.equal(busyEvent.properties.sessionID, id)
    source.close()
  } finally {
    server.close()
  }
})

test("prompt without parts is a validation error", async () => {
  const { server, base } = await startGateway()
  try {
    const id = await createSession(base)
    const response = await fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "VALIDATION_ERROR")
  } finally {
    server.close()
  }
})

test("messages, abort and stop aliases work", async () => {
  const { engine, server, base } = await startGateway()
  try {
    const id = await createSession(base)
    engine.setMessages(id, [
      { id: "m1", role: "user", content: "q", created_at: "2026-09-01T10:00:00Z" }
    ])
    const messages = await (await fetch(`${base}/session/${id}/message`)).json()
    assert.equal(messages.length, 1)
    assert.deepEqual(await (await fetch(`${base}/session/${id}/abort`, { method: "POST" })).json(), { ok: true })
    assert.deepEqual(await (await fetch(`${base}/session/${id}/stop`, { method: "POST" })).json(), { ok: true })
  } finally {
    server.close()
  }
})

test("engine unavailability surfaces as 502 BAD_GATEWAY", async () => {
  const engine = createFakeEngine()
  engine.setPromptHandler(() => { throw Object.assign(new Error("upstream died"), { code: "ENGINE_UNAVAILABLE" }) })
  const { server, base } = await startGateway({ engine })
  try {
    const id = await createSession(base)
    const response = await fetch(`${base}/session/${id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "x" }] })
    })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).code, "BAD_GATEWAY")
  } finally {
    server.close()
  }
})

test("questions are empty and replies 404 for engines without the capability", async () => {
  const { server, base } = await startGateway()
  try {
    assert.deepEqual(await (await fetch(`${base}/question`)).json(), [])
    const response = await fetch(`${base}/question/req_x/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [["A"]] })
    })
    assert.equal(response.status, 404)
  } finally {
    server.close()
  }
})

test("permission ask flows through the queue and reply resolves it", async () => {
  const engine = createFakeEngine()
  const { server, base } = await startGateway()
  try {
    const id = await createSession(base)
    // Engine-side: gateway registers a pending permission when the engine asks.
    // Simulate by hitting the wired handler the server exposes for engines that support it.
    const permission = { id: "perm_001", sessionID: id, permission: "bash.execute", patterns: ["rm -rf /tmp/x"] }
    engine.capabilities.permissions = true
    // The server learns about asks via engine question/permission callbacks — for the fake,
    // expose them through the engine's queue wiring tested in Task 13; here assert list/reply
    // against a queue entry injected through the engine bridge.
    server.gatewayInjectPermission?.(permission)
    const listed = await (await fetch(`${base}/permission`)).json()
    if (listed.length) {
      const reply = await fetch(`${base}/permission/${listed[0].id}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "always", message: "允许" })
      })
      assert.equal(reply.status, 200)
      assert.deepEqual(await reply.json(), { ok: true })
    }
  } finally {
    server.close()
  }
})
```

注意最后一个测试用 `server.gatewayInjectPermission`：Task 9 实现时给返回的 server 挂一个测试辅助属性 `gatewayInjectPermission(record)`（把权限登记进 interactionQueue 并发 `permission.asked` 事件），生产路径不使用它；Task 13 的 acp-engine 集成测试会覆盖真实提问链路。若不想在 server 上挂辅助方法，可改为从 `createGatewayServer` 返回 `{ server, askPermission(record) }`——实现时二选一并在本测试中保持一致（计划采用后者：返回对象带 `server` 字段；上面测试的 `startGateway` 相应改为 `const { server: httpServer } = gateway` 形式）。**采用方案：`createGatewayServer(...) → { server, askQuestion(record), askPermission(record) }`**，测试改为解构使用。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-server-actions.test.js`
Expected: FAIL（prompt/abort/message/question/permission 路由 404）

- [ ] **Step 3: Implement `handleSessionAction` and interaction routes**

在 `gateway-server.js` 中：

1. `createGatewayServer` 返回值改为：

```js
  const server = createServer(async (request, response) => { /* 既有路由主体不变，除下述新增 */ })
  // Engines that surface questions/permissions register them here; the routes below read the queue.
  function askQuestion(record) {
    const entry = interactionQueue.addQuestion(record.sessionID, record.questions)
    eventBus.emit({ type: "question.asked", properties: { sessionID: record.sessionID, id: entry.id, questions: record.questions } })
    return entry
  }
  function askPermission(record) {
    const entry = interactionQueue.addPermission(record.sessionID, record.permission, record.patterns)
    eventBus.emit({ type: "permission.asked", properties: { sessionID: record.sessionID, id: entry.id, permission: record.permission, patterns: record.patterns } })
    return entry
  }
  return { server, askQuestion, askPermission }
```

（Task 8 测试中对 `server.listen`/`server.address()`/`server.close()` 的直接调用改为经 `.server`；在本任务中同步更新 `gateway-server-sessions.test.js` 的 `startGateway`。）

2. 在路由主体中，`sessionMatch` 之前新增交互路由：

```js
      if (method === "GET" && path === "/question") {
        if (!engine.capabilities.questions) return writeJSON(response, 200, [])
        return writeJSON(response, 200, await engine.listQuestions())
      }
      const questionReply = path.match(/^\/question\/([^/]+)\/reply$/)
      if (questionReply && method === "POST") {
        const body = await readBody(request)
        if (!Array.isArray(body.answers)) return sendError(response, 400, "VALIDATION_ERROR", "answers is required")
        if (engine.capabilities.questions) await engine.replyQuestion(decodeURIComponent(questionReply[1]), body.answers)
        else if (!interactionQueue.resolveQuestion(decodeURIComponent(questionReply[1]), body.answers)) {
          return sendError(response, 404, "NOT_FOUND", "Question not found")
        }
        return writeJSON(response, 200, { ok: true })
      }
      if (method === "GET" && path === "/permission") {
        const queued = interactionQueue.listPermissions()
        if (queued.length || !engine.capabilities.permissions) return writeJSON(response, 200, queued)
        return writeJSON(response, 200, await engine.listPermissions())
      }
      const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/)
      if (permissionReply && method === "POST") {
        const body = await readBody(request)
        if (!["once", "always", "reject"].includes(body.reply)) {
          return sendError(response, 400, "VALIDATION_ERROR", "reply must be once, always or reject")
        }
        const requestID = decodeURIComponent(permissionReply[1])
        if (interactionQueue.resolvePermission(requestID, body)) {
          return writeJSON(response, 200, { ok: true })
        }
        if (engine.capabilities.permissions) {
          await engine.replyPermission(requestID, body)
          return writeJSON(response, 200, { ok: true })
        }
        return sendError(response, 404, "NOT_FOUND", "Permission request not found")
      }
```

3. 替换 `handleSessionAction` 的完整实现：

```js
async function handleSessionAction({ request, response, url, sessionID, action, engine, registry, eventBus, defaultModel }) {
  const method = request.method
  if (!registry.has(sessionID)) {
    sendError(response, 404, "NOT_FOUND", "Session not found")
    return true
  }

  if (action === "message" && method === "GET") {
    writeJSON(response, 200, await engine.listMessages(sessionID))
    return true
  }

  if (action === "prompt_async" && method === "POST") {
    const body = await readBody(request)
    const text = (Array.isArray(body.parts) ? body.parts : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (!body.parts || !text) {
      sendError(response, 400, "VALIDATION_ERROR", "parts with a text entry are required")
      return true
    }
    const model = body.model?.providerID && body.model?.modelID
      ? `${body.model.providerID}/${body.model.modelID}`
      : defaultModel
    registry.setStatus(sessionID, "busy")
    eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    try {
      await engine.prompt(sessionID, { text, model })
    } finally {
      // Order matters: the engine's final message must already be readable when idle is signaled.
      registry.setStatus(sessionID, "idle")
      eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
      eventBus.emit({ type: "session.idle", properties: { sessionID } })
    }
    response.writeHead(204)
    response.end()
    return true
  }

  if ((action === "abort" || action === "stop") && method === "POST") {
    await engine.abort(sessionID)
    registry.setStatus(sessionID, "idle")
    eventBus.emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    writeJSON(response, 200, { ok: true })
    return true
  }

  return false
}
```

注意：`prompt_async` 的引擎错误在 `finally` 后向外抛，由外层 catch 映射 502/500——但 204 已写的场景不存在（错误时还没写头）。此外把 `handleSessionAction` 从模块级函数改为接收闭包参数的调用点已在 Task 8 的路由主体中就位。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bridge test -- test/gateway-server-actions.test.js test/gateway-server-sessions.test.js`
Expected: PASS（全部）。同时 `npm --prefix bridge test -- test/gateway-server-sessions.test.js` 在 Step 3.1 的返回值调整后仍须全绿。

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/gateway-server.js bridge/test/gateway-server-actions.test.js bridge/test/gateway-server-sessions.test.js
git commit -m "feat(gateway): blocking prompt, abort/stop, message and interaction routes"
```

---

### Task 10: 入口 `main.js` 装配 + bin + 端到端冒烟（fake 引擎直连）

**Files:**
- Create: `bridge/src/gateway/main.js`
- Modify: `bridge/package.json`（bin 增加 `"harness-gateway": "./src/gateway/main.js"`）
- Test: `bridge/test/gateway-main.test.js`

**Interfaces:**
- Consumes: `parseGatewayOptions`、`createEngine`、`createEventBus`、`createSessionRegistry`、`createInteractionQueue`、`createGatewayServer`。
- Produces: `buildGateway(options) → { server, engine, eventBus, registry, interactionQueue }`；`main(argv)`（CLI 入口，`import.meta.url === pathToFileURL(process.argv[1]).href` 时自执行）。启动日志打到 stderr：`gateway listening on http://localhost:6217 engine=opencode`。

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-main.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildGateway } from "../src/gateway/main.js"

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
  gateway.engine === undefined // engine is created lazily by initialize; direct emit test:
  gateway.eventBus.emit({ type: "session.idle", properties: { sessionID: "s" } })
  assert.equal(seen.at(-1).type, "session.idle")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-main.test.js`
Expected: FAIL（main.js 不存在）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/main.js
import { pathToFileURL } from "node:url"
import { parseGatewayOptions, gatewayUsage } from "./options.js"
import { createEngine } from "./engines/engine-adapter.js"
import { createEventBus } from "./event-bus.js"
import { createSessionRegistry } from "./session-registry.js"
import { createInteractionQueue } from "./interaction-queue.js"
import { createGatewayServer } from "./gateway-server.js"

export function buildGateway(options) {
  const engine = createEngine(options.engine, options.engineOptions ?? {})
  const eventBus = createEventBus()
  const registry = createSessionRegistry()
  const interactionQueue = createInteractionQueue()
  const { server, askQuestion, askPermission } = createGatewayServer({
    engine, eventBus, registry, interactionQueue, defaultModel: options.defaultModel
  })
  // Engines that surface pending interactions push them through these two hooks.
  engine.onInteraction?.({
    askQuestion: (record) => askQuestion(record),
    askPermission: (record) => askPermission(record)
  })
  return { server, engine, eventBus, registry, interactionQueue }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGatewayOptions(argv)
  if (options.help) {
    process.stdout.write(`${gatewayUsage()}\n`)
    return
  }
  const gateway = buildGateway(options)
  await gateway.engine.initialize()
  await new Promise((resolve) => gateway.server.listen(options.port, options.host, resolve))
  process.stderr.write(`gateway listening on http://${options.host}:${options.port} engine=${options.engine}\n`)
  const shutdown = async () => {
    gateway.server.close()
    await gateway.engine.dispose().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}
```

同时在 `bridge/package.json` 的 `bin` 增加：

```json
    "harness-gateway": "./src/gateway/main.js"
```

`engine.onInteraction?.(...)` 钩子：OpenCode 引擎不实现（questions 经代理）；ACP 引擎在 Task 13 实现它来登记权限。工厂契约补充：Engine 可选提供 `onInteraction({ askQuestion, askPermission })`。

- [ ] **Step 4: Run tests and a real end-to-end smoke**

Run: `npm --prefix bridge test -- test/gateway-main.test.js`
Expected: PASS

手动冒烟（本机装了 opencode 时执行；没有则跳过并在 M4 补）：

```bash
node bridge/src/gateway/main.js --engine opencode --port 6217 &
sleep 3
curl -s http://localhost:6217/health
curl -s -X POST http://localhost:6217/session -H 'Content-Type: application/json' -d '{"title":"smoke"}'
kill %1
```

Expected: health 返回 `{"ok":true}`，session 创建返回 `{"id":...,"status":"idle"}`。

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/main.js bridge/package.json bridge/test/gateway-main.test.js
git commit -m "feat(gateway): wire gateway entrypoint and bin"
```

---

## Milestone M2：ACP 引擎 + 权限真实挂起

### Task 11: AcpClient 可注入权限挂起处理器（bridge 唯一行为性修改）

**Files:**
- Modify: `bridge/src/acp-client.js:40-47`（构造参数）、`:279-284`（agent-request 分发）、`:311-324`（`#respondPermission` 旁新增挂起路径）
- Test: `bridge/test/gateway-acp-permission-handler.test.js`

**Interfaces:**
- Produces: `new AcpClient({ ..., permissionHandler? })`；`permissionHandler({ sessionId, options: [{kind, optionId, ...}] }) → Promise<{ optionId: string } | null | undefined>`。返回 `{optionId}` → 回 `{outcome:"selected", optionId}`；返回 null/undefined/抛错 → 回 `{outcome:"cancelled"}`。**未注入时行为与现状逐字节一致**（allow 模式选 allow_once，否则 cancelled）。

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-acp-permission-handler.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { AcpClient } from "../src/acp-client.js"

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.pid = 4242
  return child
}

function frames(stdout) {
  const seen = []
  stdout.on("data", (chunk) => {
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
  const seen = frames(child.stdout)
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
  assert.deepEqual(reply.result, { outcome: "selected", optionId: "o2" })
})

test("a handler returning null cancels the request", async () => {
  const child = fakeChild()
  const seen = frames(child.stdout)
  const client = new AcpClient({ command: "fake", permissionHandler: () => Promise.resolve(null), spawnProcess: () => child })
  const started = client.start(1_000)
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentInfo: {}, agentCapabilities: {} } })}\n`)
  await started
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 101, method: "session/request_permission",
    params: { sessionId: "s1", options: [{ kind: "allow_once", optionId: "o1" }] }
  })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen.find((frame) => frame.id === 101).result, { outcome: "cancelled" })
})

test("without a handler the legacy auto-grant is unchanged", async () => {
  const child = fakeChild()
  const seen = frames(child.stdout)
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
  assert.deepEqual(seen.find((frame) => frame.id === 102).result, { outcome: "selected", optionId: "o1" })
})
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `npm --prefix bridge test -- test/gateway-acp-permission-handler.test.js`
Expected: 前两个 FAIL（handler 被忽略，立即收到旧回复），第三个 PASS（现状即如此）

- [ ] **Step 3: Implement the change in `acp-client.js`**

1. 构造函数新增参数与字段：

```js
  constructor({ command = "omp", args = ["acp"], permissionMode = "deny", preferredAuthMethod, permissionHandler, spawnProcess = spawn } = {}) {
    super()
    this.#command = command
    this.#args = args
    this.#permissionMode = permissionMode
    this.#preferredAuthMethod = preferredAuthMethod
    this.#permissionHandler = permissionHandler
    this.#spawn = spawnProcess
  }
```

并在字段声明区（`#preferredAuthMethod` 附近）加 `#permissionHandler`。

2. `#consumeMessage` 中 agent-request 分发改为：

```js
    if (message.id !== undefined && message.method) {
      this.emit("agent-request", message)
      if (message.method === "session/request_permission") {
        if (this.#permissionHandler) this.#deferPermission(message.id, message.params)
        else this.#respondPermission(message.id, message.params)
      } else this.#respondUnsupported(message.id, message.method)
      return
    }
```

3. 新增私有方法（放在 `#respondPermission` 旁），并把旧方法里的写回抽成 `#writeResult`：

```js
  /**
   * A gateway-injected handler owns the decision: the request stays parked until the
   * handler resolves an option (or cancels). The legacy auto-grant path is untouched.
   */
  async #deferPermission(id, params) {
    let outcome
    try {
      const reply = await this.#permissionHandler({
        sessionId: params?.sessionId,
        options: Array.isArray(params?.options) ? params.options : []
      })
      outcome = typeof reply?.optionId === "string"
        ? { outcome: "selected", optionId: reply.optionId }
        : { outcome: "cancelled" }
    } catch {
      outcome = { outcome: "cancelled" }
    }
    this.#writeResult(id, outcome)
  }

  #writeResult(id, result) {
    if (!this.#child?.stdin.writable) return
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
  }
```

`#respondPermission` 最后一行改为 `this.#writeResult(id, { outcome })`（其余逻辑不动）。

- [ ] **Step 4: Run new tests plus the full bridge suite**

Run: `npm --prefix bridge test`
Expected: 全绿（新增 3 个 + 既有全部）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/acp-client.js bridge/test/gateway-acp-permission-handler.test.js
git commit -m "feat(acp): injectable permission handler for gateway parking"
```

---

### Task 12: ACP 消息与事件规范化 `normalize-acp.js`

**Files:**
- Create: `bridge/src/gateway/engines/normalize-acp.js`
- Test: `bridge/test/gateway-normalize-acp.test.js`

**Interfaces:**
- Consumes: ACP 消息形状 `{ info: { id, role: "user"|"assistant", sessionID, time: { created } }, parts: [...] }`，part 类型 `text {text}` / `tool {tool, callID, state: {status, input, output, title}}` / `reasoning` / `file`。
- Produces:
  - `normalizeAcpMessages(messages, { busy } = { busy: false }) → NormalizedMessage[]`
  - 推导规则（设计文档 §6）：
    - user → `{id, role:"user", content, created_at}`（content = text parts 拼接）
    - assistant → parts 映射（text/tool/step-finish），**step 边界**插入 `step-finish`（text 后跟 tool、或 tool 后跟 text 处），消息末尾**仅当 `!busy`** 补一个 `step-finish`；`info.finish` = busy（且是最后一条 assistant）? `"tool-calls"` : `"stop"`；`tool_calls` = 全部 tool parts 聚合 `{id: callID, name: tool, arguments: state.input ?? {}}`；`content` = text parts 拼接
    - 每个终结的 tool part 追加一条 `{id: \`${callID}:result\`, role:"tool", tool_call_id: callID, tool_name: tool, content: state.output 摘要（字符串，最多 2000 字符）}`
    - reasoning / file part 不进入规范消息
    - `created_at` 由 `info.time.created`（毫秒 epoch）转 ISO 8601
  - `acpStatusToSpec(status)` → `"running"|"pending"` → `"running"`、`"completed"` → `"completed"`、`"error"|"incomplete"` → `"error"`（tool part state.status 映射）

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-normalize-acp.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeAcpMessages, acpStatusToSpec } from "../src/gateway/engines/normalize-acp.js"

const CREATED = Date.UTC(2026, 8, 1, 10, 0, 0)

function assistantMessage(parts, { created = CREATED } = {}) {
  return { info: { id: "msg_2", role: "assistant", sessionID: "s1", time: { created } }, parts }
}

test("a completed turn yields finish=stop with a trailing step-finish", () => {
  const normalized = normalizeAcpMessages([
    { info: { id: "msg_1", role: "user", sessionID: "s1", time: { created: CREATED } }, parts: [{ type: "text", text: "打开Outlook" }] },
    assistantMessage([
      { type: "text", text: "好的" },
      { type: "tool", tool: "launch", callID: "call_001", state: { status: "completed", input: { app: "outlook" }, output: "exit 0", title: "启动完成" } },
      { type: "text", text: "已打开" }
    ])
  ])
  assert.equal(normalized.length, 3) // user + assistant + tool result
  const assistant = normalized[1]
  assert.equal(assistant.info.finish, "stop")
  assert.deepEqual(assistant.parts.map((part) => part.type), ["text", "step-finish", "tool", "step-finish", "text", "step-finish"])
  assert.deepEqual(assistant.tool_calls, [{ id: "call_001", name: "launch", arguments: { app: "outlook" } }])
  assert.deepEqual(normalized[2], {
    id: "call_001:result", role: "tool", tool_call_id: "call_001", tool_name: "launch", content: "exit 0",
    created_at: new Date(CREATED).toISOString()
  })
})

test("a busy turn yields finish=tool-calls and no trailing step-finish", () => {
  const normalized = normalizeAcpMessages([
    assistantMessage([
      { type: "text", text: "正在处理" },
      { type: "tool", tool: "search", callID: "call_002", state: { status: "running", input: { q: "x" } } }
    ])
  ], { busy: true })
  const assistant = normalized[0]
  assert.equal(assistant.info.finish, "tool-calls")
  assert.equal(assistant.parts.at(-1).type, "tool") // still running, no trailing finish
  assert.equal(normalized.length, 1) // no tool result while running
})

test("status mapping covers the ACP vocabulary", () => {
  assert.equal(acpStatusToSpec("pending"), "running")
  assert.equal(acpStatusToSpec("running"), "running")
  assert.equal(acpStatusToSpec("completed"), "completed")
  assert.equal(acpStatusToSpec("error"), "error")
  assert.equal(acpStatusToSpec("incomplete"), "error")
  assert.equal(acpStatusToSpec(undefined), "running")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-normalize-acp.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/engines/normalize-acp.js
const OUTPUT_LIMIT = 2_000

export function acpStatusToSpec(status) {
  if (status === "completed") return "completed"
  if (status === "error" || status === "incomplete") return "error"
  return "running" // pending, running, unknown
}

function textOf(parts) {
  return (parts ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
}

function toolState(state) {
  return {
    status: acpStatusToSpec(state?.status),
    ...(state?.title !== undefined ? { title: state.title } : {})
  }
}

function clip(value) {
  if (typeof value === "string") return value.slice(0, OUTPUT_LIMIT)
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value).slice(0, OUTPUT_LIMIT)
  } catch {
    return ""
  }
}

/**
 * Step boundary: a tool part after text ends a step, and text after tools ends the tool batch.
 * A trailing step-finish is only appended when the turn is over (the session is not busy).
 */
function assistantParts(parts, { busy }) {
  const output = []
  let previousKind = undefined
  for (const part of parts ?? []) {
    if (part?.type === "text") {
      if (previousKind === "tool") output.push({ type: "step-finish" })
      output.push({ type: "text", content: part.text ?? "" })
      previousKind = "text"
    } else if (part?.type === "tool") {
      if (previousKind === "text") output.push({ type: "step-finish" })
      output.push({ type: "tool", tool: part.tool, state: toolState(part.state) })
      previousKind = "tool"
    }
    // reasoning and file parts are not part of the spec vocabulary
  }
  if (!busy && previousKind) output.push({ type: "step-finish" })
  return output
}

export function normalizeAcpMessages(messages, { busy = false } = {}) {
  if (!Array.isArray(messages)) return []
  const normalized = []
  const lastAssistantIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === "assistant") return index
    }
    return -1
  })()

  messages.forEach((message, index) => {
    const info = message?.info
    if (!info || typeof info.id !== "string") return
    const createdAt = new Date(info.time?.created ?? Date.now()).toISOString()
    if (info.role === "user") {
      normalized.push({ id: info.id, role: "user", content: textOf(message.parts), created_at: createdAt })
      return
    }
    if (info.role !== "assistant") return

    const parts = message.parts ?? []
    const isBusyTail = busy && index === lastAssistantIndex
    normalized.push({
      id: info.id,
      role: "assistant",
      content: textOf(parts),
      tool_calls: parts
        .filter((part) => part?.type === "tool")
        .map((part) => ({ id: part.callID ?? "", name: part.tool ?? "", arguments: part.state?.input ?? {} })),
      created_at: createdAt,
      info: { role: "assistant", finish: isBusyTail ? "tool-calls" : "stop" },
      parts: assistantParts(parts, { busy: isBusyTail })
    })

    for (const part of parts) {
      if (part?.type !== "tool") continue
      if (part.state?.status !== "completed" && part.state?.status !== "error" && part.state?.status !== "incomplete") continue
      normalized.push({
        id: `${part.callID ?? "tool"}:result`,
        role: "tool",
        tool_call_id: part.callID ?? "",
        tool_name: part.tool ?? "",
        content: clip(part.state?.output),
        created_at: createdAt
      })
    }
  })
  return normalized
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix bridge test -- test/gateway-normalize-acp.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/engines/normalize-acp.js bridge/test/gateway-normalize-acp.test.js
git commit -m "feat(gateway): normalize ACP messages with finish/step-finish derivation"
```

---

### Task 13: ACP 引擎适配器 + 工厂注册 omp/pi

**Files:**
- Create: `bridge/src/gateway/engines/acp-engine.js`
- Modify: `bridge/src/gateway/engines/engine-adapter.js`（注册 `omp`、`pi`）、`bridge/test/gateway-import-boundary.test.js`（允许清单加 ACP 驱动）
- Test: `bridge/test/gateway-acp-engine.test.js`（用 `FakeOmpAcp` 全链路）

**Interfaces:**
- Consumes: `harnessProfile(id)`、`resolveAcpLaunch(profile)`（`bridge/src/harness-profiles.js`）；`AcpClient`（Task 11 的 `permissionHandler`）；`AcpService`（构造 `(acp, { snapshotDirectory, historyLoader, ...profile 字段 })`，方法 `createSession/promptAndWait/abort/status/messages/subscribe/deleteSession`）；`normalizeAcpMessages`。
- Produces: `createAcpEngine({ profileId, acp?, service?, stateDirectory?, spawnProcess?, permissionBridge? }) → Engine`。`permissionBridge` 默认为 `onInteraction` 注入的 `{ askPermission }`；Engine 提供 `onInteraction({ askQuestion, askPermission })` 钩子（main.js 已在 Task 10 调用）。事件映射：`session.updated` → `session.status`（+ 转 idle 时补 `session.idle`）、`session.error` → `session.error`、`message.updated` → 逐 part diff 出 `message.part.updated`。
- `engine-adapter.js` 工厂新增分支（`Available: opencode, omp, pi`）：

```js
    case "omp":
    case "pi":
      return createAcpEngine({ profileId: id, ...options })
```

- [ ] **Step 1: Write the failing test**

```js
// bridge/test/gateway-acp-engine.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"
import { createAcpEngine } from "../src/gateway/engines/acp-engine.js"

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

test("permission requests park until reply resolves them", async () => {
  const { engine } = await acpFixture()
  const asked = []
  engine.onInteraction({ askQuestion: () => {}, askPermission: (record) => asked.push(record) })
  const { id } = await engine.createSession({ title: "t" })
  // Drive the engine's permission path directly: emit an ACP permission request on the fake.
  // (FakeOmpAcp doesn't ask permissions on its own; the engine's handler is what we verify.)
  const decision = engine.permissionDecision({ reply: "always" }, [
    { kind: "allow_once", optionId: "o1" }, { kind: "allow_always", optionId: "o2" }
  ])
  assert.deepEqual(decision, { optionId: "o2" })
  assert.equal(engine.permissionDecision({ reply: "reject" }, [{ kind: "allow_once", optionId: "o1" }]), null)
  await engine.dispose()
})
```

（`permissionDecision` 是 acp-engine 暴露的纯函数方法：把规范 reply + ACP options 映射为 `{optionId}` 或 `null`——`once`→allow_once、`always`→allow_always、`reject`→无 reject option 时 null。Task 11 的 handler 内部调用它。测试先直测映射，再由 Task 14 的 conformance 测试覆盖 HTTP 全链路。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix bridge test -- test/gateway-acp-engine.test.js`
Expected: FAIL（acp-engine.js 不存在）

- [ ] **Step 3: Write the implementation**

```js
// bridge/src/gateway/engines/acp-engine.js
import path from "node:path"
import { AcpClient } from "../../acp-client.js"
import { AcpService } from "../../acp-service.js"
import { harnessProfile, resolveAcpLaunch } from "../../harness-profiles.js"
import { normalizeAcpMessages } from "./normalize-acp.js"

const ACP_CAPABILITIES = { questions: false, permissions: true, abort: true }

export function createAcpEngine({
  profileId,
  acp,
  service,
  stateDirectory,
  spawnProcess,
  permissionBridge
} = {}) {
  const profile = harnessProfile(profileId)
  const launch = resolveAcpLaunch(profile)
  const listeners = new Set()
  const seenParts = new Map() // `${sessionID}:${messageID}` → JSON of last-seen normalized parts
  const sessionStatuses = new Map() // sessionID → "idle" | "busy"（网关创建的会话）
  let askPermissionHook = permissionBridge?.askPermission

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // listener errors must not break the engine
      }
    }
  }

  const client = acp ?? new AcpClient({
    command: launch.command,
    args: launch.args,
    permissionMode: profile.permissionMode,
    ...(spawnProcess ? { spawnProcess } : {}),
    // Park every permission ask on the gateway queue; the judge replies over HTTP.
    permissionHandler: async ({ sessionId, options }) => {
      if (!askPermissionHook) return null
      const record = {
        sessionID: sessionId,
        permission: options[0]?.kind?.startsWith("allow") ? "tool.execute" : options[0]?.kind ?? "permission",
        patterns: options.map((option) => option.name ?? option.kind).filter(Boolean)
      }
      const { settled } = askPermissionHook(record)
      const answer = await settled
      return permissionDecision(answer ?? {}, options)
    }
  })

  const engineService = service ?? new AcpService(client, {
    snapshotDirectory: stateDirectory ? path.join(stateDirectory, profile.id) : undefined,
    historyLoader: profile.historyLoader,
    preserveListedTimestamps: profile.preserveListedTimestamps,
    reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
    replaySettleMs: profile.replaySettleMs,
    preferListedTitles: profile.preferListedTitles,
    nativeRenameCommand: profile.nativeRenameCommand,
    journalPageWhileOwned: profile.journalPageWhileOwned,
    modelVariantConfigIDs: profile.modelVariantConfigIDs,
    actionProviders: profile.actionProviders
  })

  function statusOf(sessionID) {
    return engineService.status(sessionID)?.type ?? "idle"
  }

  async function emitPartUpdates(sessionID) {
    const messages = await engineService.messages(sessionID, false).catch(() => [])
    for (const message of messages ?? []) {
      const key = `${sessionID}:${message.info.id}`
      const normalizedParts = normalizeAcpMessages([message], { busy: false })[0]?.parts ?? []
      const previous = seenParts.get(key) ?? "[]"
      const current = JSON.stringify(normalizedParts)
      if (current === previous) continue
      seenParts.set(key, current)
      const previousList = JSON.parse(previous)
      normalizedParts.forEach((part, index) => {
        if (JSON.stringify(part) !== JSON.stringify(previousList[index])) {
          emit({ type: "message.part.updated", properties: { sessionID, messageID: message.info.id, part } })
        }
      })
    }
  }

  const unsubscribeService = engineService.subscribe((event) => {
    if (event.type === "session.updated" || event.type === "session.created") {
      const status = statusOf(event.sessionId)
      const previous = sessionStatuses.get(event.sessionId)
      sessionStatuses.set(event.sessionId, status)
      emit({ type: "session.status", properties: { sessionID: event.sessionId, status: { type: status } } })
      if (previous === "busy" && status === "idle") {
        emit({ type: "session.idle", properties: { sessionID: event.sessionId } })
      }
      return
    }
    if (event.type === "session.error") {
      emit({ type: "session.error", properties: { sessionID: event.sessionId, error: { message: event.message ?? "engine error" } } })
      return
    }
    if (event.type === "message.updated") {
      void emitPartUpdates(event.sessionId)
    }
  })

  return {
    id: profile.id,
    label: profile.label,
    capabilities: ACP_CAPABILITIES,

    async initialize() {
      if (!acp) await client.start()
    },

    async dispose() {
      unsubscribeService()
      client.close?.()
    },

    onInteraction({ askPermission }) {
      askPermissionHook = askPermission
    },

    /** Map a spec reply onto the ACP options the adapter offered. */
    permissionDecision,

    async createSession({ title, directory } = {}) {
      const session = await engineService.createSession({ directory: directory ?? process.cwd(), title })
      return { id: session.id }
    },

    async deleteSession(sessionID) {
      await engineService.deleteSession(sessionID)
    },

    async listSessionStatuses() {
      return Object.fromEntries([...sessionStatuses].map(([id, status]) => [id, { type: status }]))
    },

    async prompt(sessionID, { text, model } = {}) {
      await engineService.promptAndWait(sessionID, text ?? "", model)
    },

    async abort(sessionID) {
      engineService.abort(sessionID)
    },

    async listMessages(sessionID) {
      const messages = await engineService.messages(sessionID, false)
      return normalizeAcpMessages(messages, { busy: statusOf(sessionID) === "busy" })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    listQuestions: async () => [],
    replyQuestion: async () => {},
    listPermissions: async () => [],
    replyPermission: async () => {}
  }
}

/** spec reply → ACP optionId; a reply with no matching option cancels. */
export function permissionDecision({ reply }, options = []) {
  const wanted = reply === "once" ? "allow_once" : reply === "always" ? "allow_always" : "reject"
  const option = options.find((candidate) => candidate?.kind === wanted)
  return option?.optionId ? { optionId: option.optionId } : null
}
```

实现时注意三点（契约事实，非待办）：
1. `AcpService.createSession` 返回 `sessionView`，字段为 `{id, title, ...}`（`acp-service.js:26-37`），适配处取 `session.id`。
2. `AcpService.messages(sessionID, refresh)` 对自有会话返回内存缓存（ACP 消息形状），是 `emitPartUpdates` 与 `listMessages` 的数据源。
3. import 边界测试允许清单追加 `../../acp-service.js`、`../../acp-client.js`、`../../harness-profiles.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bridge test -- test/gateway-acp-engine.test.js test/gateway-import-boundary.test.js test/gateway-engine-adapter.test.js`
Expected: PASS。`gateway-engine-adapter.test.js` 的错误信息断言同步改为 `/Available: opencode, omp, pi/`。
Run: `grep -rn "replaced below\|not implemented" bridge/src/gateway/ || true`
Expected: 无输出

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/engines/acp-engine.js bridge/src/gateway/engines/engine-adapter.js \
  bridge/test/gateway-acp-engine.test.js bridge/test/gateway-import-boundary.test.js bridge/test/gateway-engine-adapter.test.js
git commit -m "feat(gateway): ACP engine adapter for omp/pi with parked permissions"
```

---

### Task 14: 规范符合性测试 `spec-conformance.test.js`（双引擎）

**Files:**
- Create: `bridge/test/gateway-spec-conformance.test.js`

**Interfaces:**
- Consumes: 规范附录 B checklist；`buildGateway`；fake OpenCode 上游（Task 7 测试中的 `fakeUpstream` 提升为 `bridge/test/helpers/fake-opencode-upstream.js` 复用）；`FakeOmpAcp`。
- Produces: 一套对两个引擎各跑一遍的 conformance 断言（创建/获取/删除会话、发消息收回复、SSE 七类事件、状态切换、abort、错误体、`directory` 参数、`--engine` 工厂可用、完成判定 `finish=stop`+`step-finish`）。

- [ ] **Step 1: Write the conformance suite**

```js
// bridge/test/gateway-spec-conformance.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { buildGateway } from "../src/gateway/main.js"
import { createEventBus } from "../src/gateway/event-bus.js"
import { createSessionRegistry } from "../src/gateway/session-registry.js"
import { createInteractionQueue } from "../src/gateway/interaction-queue.js"
import { createGatewayServer } from "../src/gateway/gateway-server.js"
import { createEngine } from "../src/gateway/engines/engine-adapter.js"
import { createFakeOpencodeUpstream } from "./helpers/fake-opencode-upstream.js"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"
import { isValidNormalizedMessage } from "../src/gateway/message-normalizer.js"

async function startSpecGateway({ engine, defaultModel = "zai/glm-5.2" } = {}) {
  const eventBus = createEventBus()
  const registry = createSessionRegistry()
  const interactionQueue = createInteractionQueue()
  const { server } = createGatewayServer({ engine, eventBus, registry, interactionQueue, defaultModel })
  engine.onInteraction?.({
    askQuestion: (record) => {
      const entry = interactionQueue.addQuestion(record.sessionID, record.questions)
      eventBus.emit({ type: "question.asked", properties: { sessionID: record.sessionID, id: entry.id, questions: record.questions } })
      return entry
    },
    askPermission: (record) => {
      const entry = interactionQueue.addPermission(record.sessionID, record.permission, record.patterns)
      eventBus.emit({ type: "permission.asked", properties: { sessionID: record.sessionID, id: entry.id, permission: record.permission, patterns: record.patterns } })
      return entry
    }
  })
  await engine.initialize()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { engine, server, base: `http://127.0.0.1:${server.address().port}` }
}

function collectSse(base, events) {
  const source = new EventSource(`${base}/event`)
  source.onmessage = (message) => events.push(JSON.parse(message.data))
  return () => source.close()
}

async function runChecklist(ctx, { expectQuestions = false } = {}) {
  const { base } = ctx
  const events = []
  const stopSse = collectSse(base, events)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(events[0]?.type, "server.connected")

  // create / read / delete sessions
  const created = await (await fetch(`${base}/session?directory=${encodeURIComponent(ctx.directory)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "conformance" })
  })).json()
  assert.equal(created.status, "idle")
  const fetched = await (await fetch(`${base}/session/${created.id}`)).json()
  assert.equal(fetched.title, "conformance")
  assert.equal(typeof fetched.message_count, "number")

  // prompt blocks, SSE covers busy → part updates → idle
  const promptResponse = await fetch(`${base}/session/${created.id}/prompt_async`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "请自动打开 Outlook 邮件客户端" }], model: { providerID: "zai", modelID: "glm-5.2" } })
  })
  assert.equal(promptResponse.status, 204)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const types = events.map((event) => event.type)
  assert.ok(types.includes("session.status"))
  assert.ok(types.includes("session.idle"))
  if (expectQuestions) assert.ok(types.includes("message.part.updated"))

  // final message passes the judge's completion rule
  const messages = await (await fetch(`${base}/session/${created.id}/message`)).json()
  const last = messages.at(-1)
  assert.equal(last.role, "assistant")
  assert.equal(last.info.finish, "stop")
  assert.ok(last.parts.some((part) => part.type === "step-finish"))
  assert.ok(isValidNormalizedMessage(last))

  // abort + status
  assert.deepEqual(await (await fetch(`${base}/session/${created.id}/abort`, { method: "POST" })).json(), { ok: true })
  const statuses = await (await fetch(`${base}/session/status`)).json()
  assert.ok(["idle", "busy"].includes(statuses[created.id]?.type))

  // interaction endpoints exist with spec shapes
  assert.ok(Array.isArray(await (await fetch(`${base}/question`)).json()))
  assert.ok(Array.isArray(await (await fetch(`${base}/permission`)).json()))

  // error bodies follow the spec table
  const missing = await fetch(`${base}/session/ses_none`)
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { code: "NOT_FOUND", message: "Session not found" })

  await fetch(`${base}/session/${created.id}`, { method: "DELETE" })
  stopSse()
}

test("conformance: opencode engine", async () => {
  const upstream = await createFakeOpencodeUpstream() // Task 7 的 fakeUpstream 提升版，返回 { server, state, port, close }
  try {
    const engine = createEngine("opencode", { manageHost: false, upstreamPort: upstream.port, pollIntervalMs: 5, promptTimeoutMs: 2_000 })
    const ctx = await startSpecGateway({ engine })
    ctx.directory = "/tmp/conformance-opencode"
    try {
      await runChecklist(ctx, { expectQuestions: true })
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
  const acp = new FakeOmpAcp({ sessionRoot: path.join(root, "sessions"), cwd: root })
  const engine = createEngine("omp", { acp, stateDirectory: path.join(root, "state") })
  const ctx = await startSpecGateway({ engine })
  ctx.directory = root
  try {
    await runChecklist(ctx, { expectQuestions: false })
  } finally {
    ctx.server.close()
    await engine.dispose()
  }
})
```

其中 `helpers/fake-opencode-upstream.js` = 把 Task 7 测试文件内的 `fakeUpstream`/`withFakeUpstream` 提取为导出（`createFakeOpencodeUpstream() → { server, state, port, close }`，`close()` 关闭 server 并等连接排空），Task 7 的原测试改为引用该 helper（消除重复，属于本任务的重构步骤）。

- [ ] **Step 2: Run to verify both engines pass**

Run: `npm --prefix bridge test -- test/gateway-spec-conformance.test.js`
Expected: PASS（2 tests）。若 ACP 侧事件/消息推导有出入，修 acp-engine/normalize-acp 而不是放宽断言。

- [ ] **Step 3: Full suite regression**

Run: `npm --prefix bridge test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add bridge/test/gateway-spec-conformance.test.js bridge/test/helpers/fake-opencode-upstream.js bridge/test/gateway-opencode-engine.test.js
git commit -m "test(gateway): spec conformance suite across both engines"
```

---

## Milestone M3：GLM5.2 配置 + Windows + 交付打包

### Task 15: GLM5.2 provider 模板 + 环境变量注入

**Files:**
- Create: `solution/config-templates/opencode.glm.json`, `solution/config-templates/README.md`

**Interfaces:**
- Produces: 可直接放入用户配置目录的 OpenCode provider 模板（zai provider，`glm-5.2` 模型，baseURL/key 从环境变量 `ZAI_BASE_URL`/`ZAI_API_KEY` 读取）与配置说明。OMP/PI 的 provider 配置指向各自官方配置文件位置，模板中给出等价键名。

- [ ] **Step 1: Write the OpenCode template**

```json
// solution/config-templates/opencode.glm.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "zai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Z.ai (GLM)",
      "options": {
        "baseURL": "${ZAI_BASE_URL}"
      },
      "models": {
        "glm-5.2": { "name": "GLM 5.2" }
      },
      "api": { "apiKey": "{env:ZAI_API_KEY}" }
    }
  }
}
```

（`${ZAI_BASE_URL}` 由网关启动时替换：`main.js` 启动前读取环境并渲染模板——若该文件被复制到 OpenCode 工作目录。若 OpenCode 自身支持环境展开则无需替换，Task 17 演练时以 `opencode models` 实测为准修正模板与说明。默认 `ZAI_BASE_URL=https://api.z.ai/api/paas/v4`。）

- [ ] **Step 2: Write the config README**

`solution/config-templates/README.md` 内容要点（完整写出，执行时逐条落实）：
1. OpenCode：把 `opencode.glm.json` 内容并入 `~/.config/opencode/opencode.json`（Windows: `%USERPROFILE%\.config\opencode\opencode.json`），设置 `ZAI_API_KEY` 与可选 `ZAI_BASE_URL`。
2. OMP：在 OMP 的 provider 配置（`~/.config/omp/`，随版本以 `omp --help` 为准）中新增 OpenAI 兼容 provider：`baseURL=$ZAI_BASE_URL`、`apiKey=$ZAI_API_KEY`、model id `glm-5.2`，provider 名 `zai`，使 wire name `zai/glm-5.2` 可选。
3. PI：PI 的 models 配置（`~/.pi/` 或项目 `.pi/`）新增同参数的 OpenAI 兼容 provider。
4. 三处模板均只依赖 `ZAI_API_KEY`/`ZAI_BASE_URL` 两个环境变量；网关默认模型 `GATEWAY_DEFAULT_MODEL=zai/glm-5.2`。
5. Task 17 演练会验证每个引擎的模型目录里出现 `zai/glm-5.2`；若某引擎配置键名有出入，在演练步骤里修正模板并回填本 README。

- [ ] **Step 3: Commit**

```bash
git add solution/config-templates/
git commit -m "docs(gateway): GLM5.2 provider templates for three engines"
```

---

### Task 16: INSTRUCTION.md + 打包脚本 + 依赖闭包清单

**Files:**
- Create: `solution/INSTRUCTION.md`, `solution/gateway.cmd`, `solution/gateway`
- Create: `bridge/src/gateway/ENGINES-DEPS.md`, `bridge/scripts/package-solution.mjs`

**Interfaces:**
- Produces: `node bridge/scripts/package-solution.mjs` → 仓库根生成 `solution.zip`（解压为 `solution/{INSTRUCTION.md, code/}`）。`code/` 包含 gateway + 静态扫描出的 bridge 驱动闭包 + `bridge/package.json` + 配置模板。`solution/gateway.cmd`（Windows）与 `solution/gateway`（sh）是规范形式启动包装：`gateway --engine opencode --port 6217`。

- [ ] **Step 1: Write INSTRUCTION.md**

`solution/INSTRUCTION.md`（完整内容，裁判可直接照做）：

````markdown
# Agent 网关参赛作品执行说明

## 环境准备

1. Node.js ≥ 22（ACP 适配器路径需要；OpenCode-only 时 ≥ 20 亦可）。`node -v` 确认。
2. 安装引擎（按需，评测哪个引擎装哪个）：
   - OpenCode：`npm install -g opencode`
   - OMP：`npm install -g oh-my-pi`（提供 `omp` 命令，含 `omp acp` 模式）
   - PI：无需单独安装 `pi`，适配器经 `npx --package=@automatalabs/pi-acp pi-acp` 拉起（首次会下载）
3. GLM5.2 配置：设置环境变量 `ZAI_API_KEY=<你的key>`（可选 `ZAI_BASE_URL=<自定义地址>`，默认 https://api.z.ai/api/paas/v4），并按 `code/solution/config-templates/README.md` 把 provider 配置并入对应引擎。
4. 依赖安装：无第三方 npm 依赖，无需 `npm install`。

## 执行方式

```bat
cd solution\code
gateway.cmd --engine opencode --port 6217
gateway.cmd --engine omp --port 6217
gateway.cmd --engine pi --port 6217
```

等价形式：`node bridge\src\gateway\main.js --engine <id> --port 6217`；环境变量 `ENGINE=<id>`、`GATEWAY_PORT=6217` 亦可。启动成功标志：stderr 打印 `gateway listening on http://localhost:6217 engine=<id>`。

## 执行完成判定

- 服务常驻（评测调用期间不退出）。就绪探测：`GET /health` → `{"ok":true}`。
- 评测按《Agent 网关接口规范》调用全部接口；每轮完成判定：SSE `session.idle` 或最后一条 assistant 消息 `info.finish=stop` 且 parts 含 `step-finish`。
- 需要人工交互时，评测通过 `GET /question`、`POST /question/{id}/reply`、`GET /permission`、`POST /permission/{id}/reply` 自动提交。

## 生成结果交付件说明

- 评测过程中如需产物，会话消息可随时 `GET /session/{id}/message` 获取；服务日志输出到 stderr。
````

`solution/gateway.cmd`：

```bat
@echo off
setlocal
node "%~dp0code\bridge\src\gateway\main.js" %*
endlocal
```

`solution/gateway`（bash）：

```bash
#!/bin/sh
exec node "$(dirname "$0")/code/bridge/src/gateway/main.js" "$@"
```

- [ ] **Step 2: Write ENGINES-DEPS.md（依赖闭包清单）**

`bridge/src/gateway/ENGINES-DEPS.md`：列出 engines/ 适配器直接 import 的 bridge 文件及其传递依赖（执行本任务时用 `node bridge/scripts/package-solution.mjs --list-deps` 生成实际清单后写入）：
- 直接：`src/acp-client.js`、`src/acp-service.js`、`src/harness-profiles.js`、`src/opencode-host.js`
- 传递（由 acp-service/harness-profiles 引入）：`src/transcript-cache.js`、`src/bounded-lru.js`、`src/omp-session-history.js`、`src/pi-session-history.js`、`src/codex-session-history.js`、`src/extension-actions.js`、`src/omp-extension-action-state.js`、`src/launcher.js`（`findExecutable`）
- 打包脚本以静态扫描结果为准，本清单是人工核对基线。

- [ ] **Step 3: Write package-solution.mjs**

```js
// bridge/scripts/package-solution.mjs
import { createReadStream, createWriteStream, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const bridgeSrc = path.join(repoRoot, "bridge", "src")
const gatewayEntry = path.join(bridgeSrc, "gateway", "main.js")

function localImports(file) {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)]
    .map((match) => path.resolve(path.dirname(file), match[1]))
    .filter((resolved) => resolved.startsWith(bridgeSrc))
}

function collectClosure(entries) {
  const closure = new Set()
  const queue = [...entries]
  while (queue.length) {
    const file = queue.pop()
    if (closure.has(file) || !existsSync(file)) continue
    closure.add(file)
    queue.push(...localImports(file))
  }
  return [...closure].sort()
}

async function copy(from, to) {
  const info = await stat(from).catch(() => null)
  if (!info) throw new Error(`packaging source missing: ${from}`)
  if (info.isDirectory()) {
    for (const entry of await readdir(from)) {
      await copy(path.join(from, entry), path.join(to, entry))
    }
    return
  }
  await mkdir(path.dirname(to), { recursive: true })
  await writeFile(to, readFileSync(from))
}

async function main() {
  const listOnly = process.argv.includes("--list-deps")
  const closure = collectClosure([gatewayEntry])
  if (listOnly) {
    for (const file of closure) console.log(path.relative(bridgeSrc, file))
    return
  }

  const stage = path.join(repoRoot, ".solution-stage", "solution")
  await mkdir(stage, { recursive: true })

  for (const file of closure) {
    await copy(file, path.join(stage, "code", "bridge", "src", path.relative(bridgeSrc, file)))
  }
  await copy(path.join(repoRoot, "bridge", "package.json"), path.join(stage, "code", "bridge", "package.json"))
  for (const overlay of ["INSTRUCTION.md", "gateway.cmd", "gateway"]) {
    const from = path.join(repoRoot, "solution", overlay)
    if (existsSync(from)) await copy(from, path.join(stage, overlay))
  }
  await copy(path.join(repoRoot, "solution", "config-templates"), path.join(stage, "code", "solution", "config-templates"))

  const zipTarget = path.join(repoRoot, "solution.zip")
  const staged = process.platform === "win32"
    ? spawnSync("powershell", ["-Command",
        `Compress-Archive -Path "${path.join(repoRoot, ".solution-stage", "solution", "*")}" -DestinationPath "${zipTarget}" -Force`])
    : spawnSync("zip", ["-r", "-q", zipTarget, "solution"], { cwd: path.join(repoRoot, ".solution-stage") })
  if (staged.status !== 0) {
    console.error(staged.stderr?.toString() ?? "zip failed")
    process.exit(1)
  }
  console.log(`packaged ${zipTarget}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
```

（打包脚本验收步骤会解压 zip 核对目录结构。）

- [ ] **Step 4: Verify packaging end-to-end**

```bash
node bridge/scripts/package-solution.mjs --list-deps
node bridge/scripts/package-solution.mjs
unzip -l solution.zip | head -40
```

Expected: `--list-deps` 输出包含 gateway 全部文件与 ENGINES-DEPS.md 所列驱动；zip 内是 `solution/INSTRUCTION.md`、`solution/gateway.cmd`、`solution/gateway`、`solution/code/bridge/...`。macOS 用 `unzip -l`，Windows 用资源管理器打开核对。

再做一个"解压即可启动"验收（fake 引擎直连，不需要真引擎）：

```bash
rm -rf /tmp/solution-check && mkdir -p /tmp/solution-check && cd /tmp/solution-check
unzip -q <repoRoot>/solution.zip
node solution/code/bridge/src/gateway/main.js --engine opencode --port 6299 &   # 无 opencode 时 initialize 报 502 属预期；换成 --help 验证入口可用
node solution/code/bridge/src/gateway/main.js --help
```

Expected: `--help` 打印 usage；`--engine opencode` 在本机有 opencode 时 `GET /health` 返回 ok。

- [ ] **Step 5: Commit**

```bash
git add solution/INSTRUCTION.md solution/gateway.cmd solution/gateway bridge/src/gateway/ENGINES-DEPS.md bridge/scripts/package-solution.mjs
git commit -m "build(gateway): solution packaging with dependency closure"
```

---

## Milestone M4：三引擎全链路演练

### Task 17: 演练脚本 + Windows 冒烟 + 模板实测修正

**Files:**
- Create: `bridge/scripts/gateway-rehearsal.mjs`

**Interfaces:**
- Produces: `node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217 --query "..."` → 对一个**已启动**的网关跑完整评测链路并打印 checklist 报告（每行 ✓/✗ + 摘要，退出码 0/1）。

- [ ] **Step 1: Write the rehearsal script**

```js
// bridge/scripts/gateway-rehearsal.mjs
const args = process.argv.slice(2)
const read = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index !== -1 ? args[index + 1] : fallback
}
const base = read("--url", "http://localhost:6217")
const query = read("--query", "请输出 hello world 并结束，不要执行任何其他操作")

const results = []
const check = (name, ok, detail = "") => results.push({ name, ok, detail })

async function main() {
  const events = []
  const source = new EventSource(`${base}/event`)
  source.onmessage = (message) => events.push(JSON.parse(message.data))

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null)
  check("health", Boolean(health?.ok))

  const session = await fetch(`${base}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "rehearsal" })
  }).then((r) => r.json()).catch(() => null)
  check("create session", Boolean(session?.id))

  const startedAt = Date.now()
  const promptResponse = await fetch(`${base}/session/${session.id}/prompt_async`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: query }] })
  })
  check("prompt returns 204", promptResponse.status === 204, `http ${promptResponse.status}`)

  const messages = await fetch(`${base}/session/${session.id}/message`).then((r) => r.json()).catch(() => [])
  const last = messages.at(-1)
  check("final message is assistant", last?.role === "assistant")
  check("finish=stop", last?.info?.finish === "stop")
  check("step-finish present", Boolean(last?.parts?.some((part) => part.type === "step-finish")))

  const types = events.map((event) => event.type)
  check("server.connected", types.includes("server.connected"))
  check("session.status", types.includes("session.status"))
  check("session.idle", types.includes("session.idle"))

  const permissions = await fetch(`${base}/permission`).then((r) => r.json()).catch(() => null)
  check("permission endpoint", Array.isArray(permissions))

  await fetch(`${base}/session/${session.id}`, { method: "DELETE" }).catch(() => {})
  source.close()

  for (const result of results) {
    console.log(`${result.ok ? "✓" : "✗"} ${result.name}${result.detail ? ` (${result.detail})` : ""}`)
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed in ${elapsed}s`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
```

- [ ] **Step 2: Rehearse each engine on this machine (macOS dev box)**

对每个已安装的引擎执行（未安装的跳过并记录）：

```bash
node bridge/src/gateway/main.js --engine opencode --port 6217 &
node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217
kill %1
# --engine omp / --engine pi 同理
```

Expected: 全部 ✓。若 OpenCode 真实上游的 `/event` 不发 `message.part.updated`（fake 假设与真实有出入），修 opencode-engine 的事件来源（改为从轮询 `/session/{id}/message` diff 出 part 更新）而不是放宽 rehearsal 检查；修正后补进 `gateway-opencode-engine.test.js` 的 fake 上游行为。GLM 模板按 Task 15 Step 2.5 实测修正。

- [ ] **Step 3: Windows smoke（实机或 CI windows runner）**

1. 在 Windows 机器 clone 仓库（或解压 solution.zip 到 `solution\`）。
2. `npm install -g opencode`（及按需 omp）。
3. `gateway.cmd --engine opencode --port 6217`，另开终端跑 `node bridge\scripts\gateway-rehearsal.mjs --url http://localhost:6217`。
4. `--engine omp` 重复；PI 若 `npx pi-acp` 拉起失败，记录现象并在风险预案里启用 claude/codex 顶替（`engine-adapter.js` 加 case + harness-profiles 已有 profile）。
Expected: Windows 上 rehearsal 全绿；结果记录进 `docs/superpowers/plans/` 同目录的执行笔记（执行者创建 `2026-09-01-multi-engine-gateway-run-notes.md` 简要记录每引擎结果）。

- [ ] **Step 4: Final full regression + package**

```bash
npm --prefix bridge test
node bridge/scripts/package-solution.mjs
```

Expected: 测试全绿；solution.zip 重新生成，包含演练期间对模板/引擎的全部修正。

- [ ] **Step 5: Commit**

```bash
git add bridge/scripts/gateway-rehearsal.mjs
git commit -m "test(gateway): end-to-end rehearsal script"
```

---

## Self-Review 记录

- **Spec coverage**：设计文档 §3.1（import 边界 → Task 5 测试）、§4 契约（Task 5/7/13）、§5 端点表（Task 8/9 全部 14 端点 + health）、§6 消息规范化（Task 6/12）、§7 权限挂起（Task 11/13/9）、§8 GLM（Task 15）、§9 Windows/交付（Task 16/17）、§10 测试（Task 14 conformance）、§11 里程碑（M1=Task1-10、M2=Task11-14、M3=Task15-16、M4=Task17）、§13 迁库（ENGINES-DEPS.md，Task 16）。
- **占位符**：Task 5 的 opencode-engine 骨架是显式的两任务过渡设计，Task 7 的验收步骤（grep 无 `not implemented yet`）保证最终态无残留；Task 13/16 代码均为可直接落盘的完整实现。
- **类型一致性**：`{type, properties}` 事件形状、Engine 方法名、`createGatewayServer → { server, askQuestion, askPermission }`（Task 9 起统一）、`permissionDecision` 导出与内用一致。
