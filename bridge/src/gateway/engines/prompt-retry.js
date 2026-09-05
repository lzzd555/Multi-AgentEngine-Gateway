// bridge/src/gateway/engines/prompt-retry.js
// 引擎层 prompt 超时与倍增重试。第 N 次尝试的时长上限 = baseTimeoutMs × 2^(N-1)；
// 只在超时上重试：重试前先 abort 残留回合（等价于人工"中止后重问"，office 类任务幂等），
// 非超时错误立即上抛。单次模式（maxAttempts ≤ 1，默认）零包装直通，行为与历史版本一致。
//
// 超时识别：引擎自身带时钟时（OpenCode 的 waitUntilIdle），调用级 timeoutMs 让内部钟
// 先行触发并携带 promptTimeout 标记；无墙钟的引擎（ACP 走 300s 不活动看门狗）由本层的
// 外层竞速钟（timeoutMs + timeoutSlackMs 裕量）兜底。两种来源都视为可重试的超时。
const TIMED_OUT = Symbol("prompt-timed-out")

function timeoutError(message) {
  return Object.assign(new Error(message), { promptTimeout: true, code: "ENGINE_UNAVAILABLE" })
}

function withTimeout(promise, ms, sleepImpl) {
  return Promise.race([promise, sleepImpl(ms).then(() => TIMED_OUT)]).then((result) => {
    if (result === TIMED_OUT) throw timeoutError(`prompt timed out after ${ms}ms`)
    return result
  })
}

export function withPromptRetry(engine, {
  maxAttempts = 1,
  baseTimeoutMs = 600_000,
  timeoutSlackMs = 5_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // 默认走 stderr（网关日志通道），重试对评测方透明但对运维可见；测试可注入收集。
  warn = (message) => process.stderr.write(`gateway prompt retry: ${message}\n`)
} = {}) {
  if (!(Number.isInteger(maxAttempts) && maxAttempts > 1)) return engine
  return {
    ...engine,
    async prompt(sessionID, options = {}) {
      const budgets = []
      let timeoutMs = baseTimeoutMs
      for (let attempt = 1; ; attempt += 1) {
        budgets.push(timeoutMs)
        try {
          return await withTimeout(
            engine.prompt(sessionID, { ...options, timeoutMs }),
            timeoutMs + timeoutSlackMs,
            sleepImpl
          )
        } catch (error) {
          if (error?.promptTimeout !== true) throw error
          if (attempt >= maxAttempts) {
            throw timeoutError(`prompt timed out after ${attempt} attempt(s) (budgets ${budgets.join("/")}ms)`)
          }
          warn(`prompt attempt ${attempt}/${maxAttempts} timed out after ${timeoutMs}ms; aborting the turn and retrying with ${timeoutMs * 2}ms`)
          await engine.abort(sessionID).catch(() => {})
          timeoutMs *= 2
        }
      }
    }
  }
}
