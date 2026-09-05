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
import { createAcpEngine } from "./acp-engine.js"
import { assertEngineConformance } from "./engine-contract.js"

export function createEngine(id, options = {}) {
  switch (id) {
    case "opencode":
      return assertEngineConformance(createOpenCodeEngine(options))
    case "omp":
    case "pi":
      return assertEngineConformance(createAcpEngine({ profileId: id, ...options }))
    default:
      throw new Error(`Unknown engine: ${id}. Available: opencode, omp, pi`)
  }
}
