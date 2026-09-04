// bridge/test/gateway-normalize-acp.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeAcpMessages, acpStatusToSpec } from "../src/gateway/engines/normalize-acp.js"
import { isValidNormalizedMessage } from "../src/gateway/message-normalizer.js"

const CREATED = Date.UTC(2026, 8, 1, 10, 0, 0)

function assistantMessage(parts, { created = CREATED } = {}) {
  return { info: { id: "msg_2", role: "assistant", sessionID: "s1", time: { created } }, parts }
}

test("a completed interleaved turn splits into step messages ending with an assistant stop", () => {
  const normalized = normalizeAcpMessages([
    { info: { id: "msg_1", role: "user", sessionID: "s1", time: { created: CREATED } }, parts: [{ type: "text", text: "打开Outlook" }] },
    assistantMessage([
      { type: "text", text: "好的" },
      { type: "tool", tool: "launch", callID: "call_001", state: { status: "completed", input: { app: "outlook" }, output: "exit 0", title: "启动完成" } },
      { type: "text", text: "已打开" }
    ])
  ])
  // 规范 §8.4：末条消息必须是 assistant(finish=stop, 含 step-finish)——OMP 单条大消息按 step 拆分后：
  // user → 文本段 assistant → 工具段 assistant → 工具结果 → 收尾文本段 assistant
  assert.equal(normalized.length, 5)
  assert.deepEqual(normalized.map((message) => message.role), ["user", "assistant", "assistant", "tool", "assistant"])
  assert.deepEqual(normalized[1].parts.map((part) => part.type), ["text", "step-finish"])
  assert.equal(normalized[1].content, "好的")
  assert.equal(normalized[1].info.finish, "stop")
  assert.deepEqual(normalized[2].tool_calls, [{ id: "call_001", name: "launch", arguments: { app: "outlook" } }])
  assert.equal(normalized[2].info.finish, "tool-calls")
  assert.deepEqual(normalized[3], {
    id: "call_001:result", role: "tool", tool_call_id: "call_001", tool_name: "launch", content: "exit 0",
    created_at: new Date(CREATED).toISOString()
  })
  const tail = normalized.at(-1)
  assert.equal(tail.role, "assistant")
  assert.equal(tail.info.finish, "stop")
  assert.equal(tail.content, "已打开")
  assert.deepEqual(tail.parts.map((part) => part.type), ["text", "step-finish"])
})

test("a completed tool-only tail appends a closing assistant so the turn ends assistant-first", () => {
  const normalized = normalizeAcpMessages([
    assistantMessage([
      { type: "tool", tool: "write", callID: "call_9", state: { status: "completed", input: {}, output: "wrote" } }
    ])
  ])
  assert.deepEqual(normalized.map((message) => message.role), ["assistant", "tool", "assistant"])
  const tail = normalized.at(-1)
  assert.equal(tail.info.finish, "stop")
  assert.deepEqual(tail.parts, [{ type: "step-finish" }])
})

test("a single-text message keeps the historical one-message shape", () => {
  const normalized = normalizeAcpMessages([assistantMessage([{ type: "text", text: "完成" }])])
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].id, "msg_2")
  assert.equal(normalized[0].info.finish, "stop")
  assert.deepEqual(normalized[0].parts.map((part) => part.type), ["text", "step-finish"])
})

test("a busy turn yields finish=tool-calls on the tail segment and no trailing step-finish", () => {
  const normalized = normalizeAcpMessages([
    assistantMessage([
      { type: "text", text: "正在处理" },
      { type: "tool", tool: "search", callID: "call_002", state: { status: "running", input: { q: "x" } } }
    ])
  ], { busy: true })
  // 文本段（中间步骤）+ 工具段（忙碌尾）：尾段 finish=tool-calls 且无 step-finish，无收尾消息
  assert.equal(normalized.length, 2)
  assert.deepEqual(normalized.map((message) => message.role), ["assistant", "assistant"])
  const tail = normalized.at(-1)
  assert.equal(tail.info.finish, "tool-calls")
  assert.equal(tail.parts.at(-1).type, "tool") // still running, no trailing finish
})

test("a completed reasoning-only turn still yields a trailing step-finish", () => {
  const normalized = normalizeAcpMessages([
    assistantMessage([{ type: "reasoning", text: "思考中" }])
  ])
  assert.equal(normalized.length, 1)
  const assistant = normalized[0]
  assert.equal(assistant.info.finish, "stop")
  assert.deepEqual(assistant.parts, [{ type: "step-finish" }])
})

test("status mapping covers the ACP vocabulary", () => {
  assert.equal(acpStatusToSpec("pending"), "running")
  assert.equal(acpStatusToSpec("running"), "running")
  assert.equal(acpStatusToSpec("completed"), "completed")
  assert.equal(acpStatusToSpec("error"), "error")
  assert.equal(acpStatusToSpec("incomplete"), "error")
  assert.equal(acpStatusToSpec(undefined), "running")
})

test("an error-only assistant message must not fake the completion signal", () => {
  const normalized = normalizeAcpMessages([
    { info: { id: "a_err", role: "assistant", sessionID: "s1", time: { created: CREATED }, error: { name: "HarnessTurnError", message: "Request timed out." } }, parts: [] }
  ])
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].info.finish, "error")
  assert.deepEqual(normalized[0].parts, [])
  assert.equal(normalized[0].content, "")
  assert.equal(isValidNormalizedMessage(normalized[0]), false)
})

test("an assistant message with real output keeps stop+step-finish even if it also errors", () => {
  const normalized = normalizeAcpMessages([
    { info: { id: "a_mix", role: "assistant", sessionID: "s1", time: { created: CREATED }, error: { name: "X", message: "trailing" } }, parts: [{ type: "text", text: "real reply" }] }
  ])
  assert.equal(normalized[0].info.finish, "stop")
  assert.ok(normalized[0].parts.some((part) => part.type === "step-finish"))
})
