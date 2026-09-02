// bridge/test/omp-session-history-root.test.js
// OMP journal 默认根目录必须与 OMP 子进程一致地跟随 PI_CONFIG_DIR（PI loader 已跟随其
// 环境变量，OMP 不跟随会造成"子进程写入重定向根、网关仍读 ~/.omp"的不对称）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createOmpHistoryLoader, defaultOmpSessionRoot } from "../src/omp-session-history.js"

test("defaultOmpSessionRoot defaults to ~/.omp and follows PI_CONFIG_DIR at call time", () => {
  delete process.env.PI_CONFIG_DIR
  assert.equal(defaultOmpSessionRoot(), path.join(os.homedir(), ".omp", "agent", "sessions"))
  process.env.PI_CONFIG_DIR = ".custom-omp-root"
  try {
    // 在 import 之后设置 env 仍生效：取值发生在调用时，而非模块加载时
    assert.equal(defaultOmpSessionRoot(), path.join(os.homedir(), ".custom-omp-root", "agent", "sessions"))
  } finally {
    delete process.env.PI_CONFIG_DIR
  }
})

test("createOmpHistoryLoader() default reads journals under ~/<PI_CONFIG_DIR>/agent/sessions", async () => {
  // PI_CONFIG_DIR 是 home 相对名，临时根必须建在 home 下（与 provision 测试同理）
  const root = fs.mkdtempSync(path.join(os.homedir(), ".omp-root-test-"))
  process.env.PI_CONFIG_DIR = path.relative(os.homedir(), root)
  try {
    const sessionsDir = path.join(root, "agent", "sessions")
    fs.mkdirSync(sessionsDir, { recursive: true })
    const file = path.join(sessionsDir, "2026-09-02_session1.jsonl")
    fs.writeFileSync(file, [
      JSON.stringify({ type: "title", title: "t" }),
      JSON.stringify({ type: "session", id: "session1" }),
      JSON.stringify({ type: "message", id: "e1", timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-02T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } }),
      ""
    ].join("\n"))
    const loader = createOmpHistoryLoader() // 无参构造：默认根必须来自当前 PI_CONFIG_DIR
    const messages = await loader("session1")
    assert.equal(messages.length, 2)
    assert.equal(messages.at(-1).parts[0].text, "hi there")
  } finally {
    delete process.env.PI_CONFIG_DIR
    fs.rmSync(root, { recursive: true, force: true })
  }
})
