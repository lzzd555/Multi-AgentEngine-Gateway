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

// Real opencode 1.x wire envelope, captured from a live `opencode serve` probe.
const realEnvelopeTurn = [
  {
    info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 1788314822248 } },
    parts: [{ type: "text", text: "打开Outlook" }]
  },
  {
    info: {
      id: "msg_a1", sessionID: "s1", role: "assistant",
      time: { created: 1788314822260, completed: 1788314829422 },
      modelID: "mimo-v2.5-free", providerID: "opencode"
    },
    parts: [
      { type: "text", text: "好的，正在打开" },
      { type: "tool", tool: "launch", state: { status: "completed", input: { app: "outlook" }, output: "exit 0", title: "启动完成" } },
      { type: "text", text: "已打开" },
      { type: "step-finish" }
    ]
  }
]

test("real opencode {info, parts} envelope maps to the spec shape", () => {
  const normalized = normalizeOpenCodeMessages(realEnvelopeTurn)
  assert.equal(normalized.length, 3) // user + assistant + synthesized tool result
  const [user, assistant, toolResult] = normalized
  assert.equal(user.role, "user")
  assert.equal(user.content, "打开Outlook")
  assert.match(user.created_at, /^2026-/)

  assert.equal(assistant.role, "assistant")
  assert.equal(assistant.content, "好的，正在打开已打开")
  assert.equal(assistant.info.finish, "stop") // time.completed present
  assert.deepEqual(assistant.tool_calls, [{ id: "call_0", name: "launch", arguments: { app: "outlook" } }])
  assert.deepEqual(assistant.parts.at(-1), { type: "step-finish" })
  assert.ok(isValidNormalizedMessage(assistant))

  assert.equal(toolResult.role, "tool")
  assert.equal(toolResult.tool_name, "launch")
  assert.equal(toolResult.content, "exit 0")
})

test("an unfinished envelope turns into tool-calls without an injected step-finish", () => {
  const [assistant] = normalizeOpenCodeMessages([{
    info: { id: "msg_a2", role: "assistant", time: { created: 1788314822260 } },
    parts: [{ type: "text", text: "思考中" }]
  }])
  assert.equal(assistant.info.finish, "tool-calls")
  assert.deepEqual(assistant.parts, [{ type: "text", content: "思考中" }])
})

test("a completed message lacking a native step-finish gets one appended", () => {
  const [assistant] = normalizeOpenCodeMessages([{
    info: { id: "msg_a3", role: "assistant", time: { created: 1788314822260, completed: 1788314829999 } },
    parts: [{ type: "text", text: "done" }]
  }])
  assert.equal(assistant.info.finish, "stop")
  assert.deepEqual(assistant.parts, [{ type: "text", content: "done" }, { type: "step-finish" }])
  assert.ok(isValidNormalizedMessage(assistant))
})
