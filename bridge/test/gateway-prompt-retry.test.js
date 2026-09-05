// bridge/test/gateway-prompt-retry.test.js
// 引擎层 prompt 超时与倍增重试：第 N 次尝试的时长上限 = promptTimeoutMs × 2^(N-1)；
// 只在超时上重试（重试前 abort 残留回合），其他错误立即上抛；单次模式零包装直通。
// 超时用受控时钟触发（而非即时 resolve 的 sleep），避免与真实 promise 在微任务层赛跑。
import { test } from "node:test"
import assert from "node:assert/strict"
import { withPromptRetry } from "../src/gateway/engines/prompt-retry.js"

const tick = () => new Promise((resolve) => setImmediate(resolve))

function controlledSleep() {
  const pending = []
  return {
    sleep: (ms) => new Promise((resolve) => pending.push({ ms, resolve })),
    fire: () => pending.splice(0).forEach(({ resolve }) => resolve()),
    budgetOf: (index) => pending.map(({ ms }) => ms)[index]
  }
}

function fakeEngine({ onPrompt } = {}) {
  const calls = { promptOptions: [], aborts: 0 }
  const engine = {
    id: "fake",
    label: "Fake",
    capabilities: { questions: false, permissions: false, abort: true },
    async prompt(sessionID, options) {
      calls.promptOptions.push(options)
      return onPrompt?.(calls.promptOptions.length, options)
    },
    async abort() {
      calls.aborts += 1
    },
    async listMessages() {
      return []
    }
  }
  return { engine, calls }
}

test("single-attempt configuration returns the engine untouched", () => {
  const { engine } = fakeEngine()
  assert.equal(withPromptRetry(engine, { maxAttempts: 1, baseTimeoutMs: 1000 }), engine)
  assert.equal(withPromptRetry(engine, {}), engine)
})

test("wrapped engine keeps every other engine method", async () => {
  const { engine } = fakeEngine()
  const wrapped = withPromptRetry(engine, { maxAttempts: 2, baseTimeoutMs: 1000, sleepImpl: controlledSleep().sleep, timeoutSlackMs: 0 })
  assert.equal(wrapped.id, "fake")
  assert.equal(wrapped.capabilities, engine.capabilities)
  assert.deepEqual(await wrapped.listMessages("s1"), [])
})

test("second attempt succeeds with a doubled timeout; the turn is aborted in between", async () => {
  const { engine, calls } = fakeEngine({
    onPrompt: (attempt) => (attempt === 1 ? new Promise(() => {}) : "done")
  })
  const clock = controlledSleep()
  const warnings = []
  const wrapped = withPromptRetry(engine, {
    maxAttempts: 3,
    baseTimeoutMs: 1000,
    timeoutSlackMs: 0,
    sleepImpl: clock.sleep,
    warn: (message) => warnings.push(message)
  })
  const result = wrapped.prompt("s1", { text: "hi" })
  await tick()
  clock.fire() // 第 1 次尝试超时
  assert.equal(await result, "done")
  assert.deepEqual(calls.promptOptions.map((options) => options.timeoutMs), [1000, 2000], "第 2 次尝试的时长上限翻倍")
  assert.equal(calls.aborts, 1, "超时后先中止残留回合再重发")
  assert.equal(calls.promptOptions.at(-1).text, "hi", "重发保留原始 prompt 语义")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /1000ms.*2000ms/)
})

test("exhausting attempts throws a timeout summary with doubled budgets", async () => {
  const { engine, calls } = fakeEngine({ onPrompt: () => new Promise(() => {}) })
  const clock = controlledSleep()
  const wrapped = withPromptRetry(engine, { maxAttempts: 3, baseTimeoutMs: 1000, timeoutSlackMs: 0, sleepImpl: clock.sleep })
  const result = wrapped.prompt("s1", { text: "hi" })
  for (let i = 0; i < 3; i += 1) {
    await tick()
    assert.equal(clock.budgetOf(0), [1000, 2000, 4000][i], `外层竞速钟第 ${i + 1} 次的预算翻倍`)
    clock.fire()
  }
  await assert.rejects(
    () => result,
    (error) => error.promptTimeout === true
      && error.code === "ENGINE_UNAVAILABLE"
      && /3 attempt/.test(error.message)
      && /1000\/2000\/4000ms/.test(error.message)
  )
  assert.equal(calls.promptOptions.length, 3)
  assert.equal(calls.aborts, 2, "每次失败尝试后都中止")
})

test("non-timeout errors propagate immediately without retry or abort", async () => {
  const { engine, calls } = fakeEngine({ onPrompt: () => Promise.reject(new Error("provider down")) })
  const clock = controlledSleep()
  const wrapped = withPromptRetry(engine, { maxAttempts: 3, baseTimeoutMs: 1000, timeoutSlackMs: 0, sleepImpl: clock.sleep })
  await assert.rejects(() => wrapped.prompt("s1", { text: "hi" }), /provider down/)
  assert.equal(calls.promptOptions.length, 1)
  assert.equal(calls.aborts, 0)
  clock.fire() // 清理挂起的计时器，避免句柄滞留
})

test("engine-tagged prompt timeouts (OpenCode internal clock) also trigger the retry", async () => {
  const { engine, calls } = fakeEngine({
    onPrompt: (attempt) => {
      if (attempt === 1) {
        throw Object.assign(new Error("OpenCode prompt timed out after 1000ms"), { promptTimeout: true, code: "ENGINE_UNAVAILABLE" })
      }
      return "done"
    }
  })
  const wrapped = withPromptRetry(engine, { maxAttempts: 2, baseTimeoutMs: 1000, timeoutSlackMs: 0, sleepImpl: controlledSleep().sleep })
  assert.equal(await wrapped.prompt("s1", { text: "hi" }), "done")
  assert.equal(calls.aborts, 1)
})

test("retry warnings surface on stderr by default (no injected warn)", async () => {
  const original = process.stderr.write.bind(process.stderr)
  const seen = []
  process.stderr.write = (chunk) => { seen.push(String(chunk)); return true }
  try {
    const { engine } = fakeEngine({ onPrompt: (attempt) => (attempt === 1 ? new Promise(() => {}) : "done") })
    const clock = controlledSleep()
    const wrapped = withPromptRetry(engine, { maxAttempts: 2, baseTimeoutMs: 1000, timeoutSlackMs: 0, sleepImpl: clock.sleep })
    const result = wrapped.prompt("s1", { text: "hi" })
    await tick()
    clock.fire()
    assert.equal(await result, "done")
  } finally {
    process.stderr.write = original
  }
  assert.ok(seen.some((line) => /prompt attempt 1\/2 timed out after 1000ms/.test(line)), `stderr 应出现重试告警，实际: ${JSON.stringify(seen)}`)
})
