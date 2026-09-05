// bridge/src/gateway/engines/prompt-retry.js
// 引擎层 prompt 超时与倍增重试。第 N 次尝试的时长上限：
//   exponential（默认）= baseTimeoutMs × 2^(N-1)；fixed = 每次 baseTimeoutMs（等额分段，
//   对"provider 停滞导致单次调用挂死"的场景比倍增健壮——多次独立机会而非一个长篮子）。
// 只在超时上重试：重试前先 abort 残留回合（等价于人工"中止后重问"，office 类任务幂等），
// 非超时错误立即上抛。单次模式（maxAttempts ≤ 1，默认）零包装直通，行为与历史版本一致。
//
// 超时识别有三个来源，都收敛为 promptTimeout 标记：
//   1) 引擎自身带时钟时（OpenCode 的 waitUntilIdle），调用级 timeoutMs 让内部钟先行触发；
//   2) 无墙钟引擎（ACP 走 300s 不活动看门狗）由本层外层竞速钟（timeoutMs + slack）兜底；
//   3) 活动看门狗：尝试发起后 firstActivityTimeoutMs 内无任何该会话的引擎事件（part 更新/
//      状态翻转）即判死——实测 provider 停滞时单次调用可 1200s 零 token（2026-09-05 office_022），
//      而健康推理的最长静默段实测约 302s，默认 360s 覆盖健康尾部；0 关闭。
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
  backoff = "exponential",
  firstActivityTimeoutMs = 360_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer),
  // 默认走 stderr（网关日志通道），重试对评测方透明但对运维可见；测试可注入收集。
  warn = (message) => process.stderr.write(`gateway prompt retry: ${message}\n`)
} = {}) {
  if (!(Number.isInteger(maxAttempts) && maxAttempts > 1)) return engine
  const subscribe = typeof engine.subscribe === "function" ? engine.subscribe.bind(engine) : null
  return {
    ...engine,
    async prompt(sessionID, options = {}) {
      const budgets = []
      let timeoutMs = baseTimeoutMs
      for (let attempt = 1; ; attempt += 1) {
        budgets.push(timeoutMs)
        let sawActivity = false
        let guardTimer
        const unsubscribe = subscribe?.((event) => {
          if (event?.properties?.sessionID === sessionID) sawActivity = true
        })
        try {
          const call = withTimeout(
            engine.prompt(sessionID, { ...options, timeoutMs }),
            timeoutMs + timeoutSlackMs,
            sleepImpl
          )
          if (firstActivityTimeoutMs > 0) {
            // 定时器在尝试结束（finally）时取消：默认 360s 的挂起定时器会拖住进程退出。
            const activityGuard = new Promise((_, reject) => {
              guardTimer = setTimeoutImpl(() => {
                if (!sawActivity) reject(timeoutError(`no model activity within ${firstActivityTimeoutMs}ms of the attempt`))
              }, firstActivityTimeoutMs)
            })
            return await Promise.race([call, activityGuard])
          }
          return await call
        } catch (error) {
          if (error?.promptTimeout !== true) throw error
          if (attempt >= maxAttempts) {
            throw timeoutError(`prompt timed out after ${attempt} attempt(s) (budgets ${budgets.join("/")}ms)`)
          }
          const nextBudget = backoff === "fixed" ? timeoutMs : timeoutMs * 2
          warn(`prompt attempt ${attempt}/${maxAttempts} ${error.message}; aborting the turn and retrying with ${nextBudget}ms`)
          await engine.abort(sessionID).catch(() => {})
          timeoutMs = nextBudget
        } finally {
          if (guardTimer !== undefined) clearTimeoutImpl(guardTimer)
          unsubscribe?.()
        }
      }
    }
  }
}
