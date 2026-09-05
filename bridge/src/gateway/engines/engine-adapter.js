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
//   prompt(id, { text, model, timeoutMs }) → Promise<void>,   // blocks until the turn finishes;
//                                                              // timeoutMs is the attempt budget the
//                                                              // retry wrapper hands down (doubled per attempt)
//   abort(id) → Promise<void>,
//   listMessages(id) → Promise<NormalizedMessage[]>,
//   subscribe(listener) → unsubscribe,              // emits { type, properties } spec events only
//   listQuestions() → Promise<records>, replyQuestion(id, answers) → Promise<void>,
//   listPermissions() → Promise<records>, replyPermission(id, { reply, message }) → Promise<void>
// }
// Engine-unreachable failures reject with an Error carrying code "ENGINE_UNAVAILABLE".
// createEngine additionally wraps prompt with timeout-and-doubling retry when the caller passes
// promptMaxAttempts > 1 (options.promptTimeoutMs is attempt 1's budget) — see prompt-retry.js.
import { createOpenCodeEngine } from "./opencode-engine.js"
import { createAcpEngine } from "./acp-engine.js"
import { assertEngineConformance } from "./engine-contract.js"
import { withPromptRetry } from "./prompt-retry.js"

export function createEngine(id, options = {}) {
  let engine
  switch (id) {
    case "opencode":
      engine = createOpenCodeEngine(options)
      break
    case "omp":
    case "pi":
      engine = createAcpEngine({ profileId: id, ...options })
      break
    default:
      throw new Error(`Unknown engine: ${id}. Available: opencode, omp, pi`)
  }
  return withPromptRetry(assertEngineConformance(engine), {
    ...(options.promptMaxAttempts !== undefined ? { maxAttempts: options.promptMaxAttempts } : {}),
    ...(options.promptTimeoutMs !== undefined ? { baseTimeoutMs: options.promptTimeoutMs } : {})
  })
}
