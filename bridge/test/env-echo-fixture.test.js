// bridge/test/env-echo-fixture.test.js
// 离线验证载体：拉起 test/fixtures/env-echo-mcp.mjs，完成 initialize → tools/list → tools/call
// 的 JSON-RPC 2.0 全回路，验证子进程 env 里的值可经工具结果原样回传。
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const FIXTURE = fileURLToPath(new URL("./fixtures/env-echo-mcp.mjs", import.meta.url))

function startFixture() {
  // 剥离 runner 注入的 NODE_TEST_CONTEXT：本测试进程是 runner 子进程，但被 spawn 的 fixture
  // 是真实的 MCP server 子进程，不能被 fixture 的 runner 空跑守卫拦截。
  const childEnv = { ...process.env, CHILD_TOKEN: "child-secret" }
  delete childEnv.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [FIXTURE], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  })
  const pending = new Map()
  let buffer = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        const message = JSON.parse(line)
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        }
      }
      newline = buffer.indexOf("\n")
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return new Promise((resolve) => pending.set(message.id, resolve))
  }
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  // spawn 失败（ENOENT）或提前退出时拒绝挂起请求，测试以明确失败而非悬挂收场
  const failure = new Promise((_, reject) => {
    child.once("error", (error) => reject(error))
    child.once("close", () => reject(new Error("fixture exited before answering all requests")))
  })
  const request = (message) => Promise.race([send(message), failure])
  // 收尾等待用 close（spawn 失败时不触发 exit），提前挂接避免错过事件
  const closed = new Promise((resolve) => {
    child.once("close", () => resolve())
    child.once("error", () => resolve())
  })
  return { child, request, notify, getStderr: () => stderr, closed }
}

test("env-echo fixture round-trips initialize, tools/list, and tools/call", async () => {
  const { child, request, notify, getStderr, closed } = startFixture()
  try {
    const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
    assert.equal(init.result.serverInfo.name, "env-echo")
    assert.equal(init.result.protocolVersion, "2025-06-18")
    // 引擎协商的协议版本可能不同：回显客户端值而非硬编码
    const initOlder = await request({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } })
    assert.equal(initOlder.result.protocolVersion, "2025-03-26")
    notify("notifications/initialized") // 通知不得产生任何响应（无 id 可匹配，泄漏会使后续断言错位）
    const list = await request({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    assert.equal(list.result.tools.length, 1)
    assert.deepEqual(list.result.tools[0], {
      name: "echo_env",
      description: "Return the value of the given environment variable",
      inputSchema: { type: "object", properties: { var: { type: "string" } }, required: ["var"] }
    })
    const call = await request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo_env", arguments: { var: "CHILD_TOKEN" } } })
    assert.deepEqual(call.result.content, [{ type: "text", text: "child-secret" }])
    const missing = await request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo_env", arguments: { var: "NO_SUCH_TOKEN" } } })
    assert.deepEqual(missing.result.content, [{ type: "text", text: "<unset:NO_SUCH_TOKEN>" }])
    const unknown = await request({ jsonrpc: "2.0", id: 6, method: "bogus/method" })
    assert.equal(unknown.error.code, -32601)
  } finally {
    child.kill("SIGTERM")
    await closed
    assert.equal(getStderr(), "") // 干净回路不应有 stderr 杂音
  }
})
