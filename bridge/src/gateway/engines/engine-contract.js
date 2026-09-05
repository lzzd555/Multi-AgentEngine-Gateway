// bridge/src/gateway/engines/engine-contract.js
// The Engine contract is documented on engine-adapter.js and intentionally stays comment-only
// for engines themselves (zero-dependency plain objects). This module turns the load-bearing
// parts into a runtime assertion so a new engine that misses or misnames a method fails at the
// factory seam, not as a 500 mid-request. createEngine() runs it on every engine it hands out.
export const ENGINE_METHODS = Object.freeze([
  "initialize", "dispose",
  "createSession", "deleteSession", "listSessionStatuses",
  "prompt", "abort", "listMessages", "subscribe",
  "listQuestions", "replyQuestion", "listPermissions", "replyPermission"
])

// onInteraction is deliberately absent: only engines that push interactions implement it, and
// the gateway core calls it optionally.

export const ENGINE_CAPABILITY_KEYS = Object.freeze(["questions", "permissions", "abort"])

export function assertEngineConformance(engine) {
  if (!engine || typeof engine !== "object") {
    throw new Error("engine contract violation: engine is not an object")
  }
  const id = typeof engine.id === "string" && engine.id ? engine.id : "unknown"
  const problems = []
  if (typeof engine.id !== "string" || !engine.id) problems.push("id must be a non-empty string")
  if (typeof engine.label !== "string" || !engine.label) problems.push("label must be a non-empty string")
  for (const method of ENGINE_METHODS) {
    if (typeof engine[method] !== "function") problems.push(`missing method: ${method}`)
  }
  const capabilities = engine.capabilities
  if (!capabilities || typeof capabilities !== "object") {
    problems.push("capabilities must be an object")
  } else {
    for (const key of ENGINE_CAPABILITY_KEYS) {
      if (typeof capabilities[key] !== "boolean") problems.push(`capabilities.${key} must be a boolean`)
    }
  }
  if (problems.length) throw new Error(`engine contract violation (${id}): ${problems.join("; ")}`)
  return engine
}
