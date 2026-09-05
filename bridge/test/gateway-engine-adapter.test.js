// bridge/test/gateway-engine-adapter.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createEngine } from "../src/gateway/engines/engine-adapter.js"
import { assertEngineConformance, ENGINE_METHODS } from "../src/gateway/engines/engine-contract.js"

test("unknown engine id is rejected with the available list", () => {
  assert.throws(() => createEngine("nope"), /Unknown engine: nope\. Available: opencode, omp, pi/)
})

// Constructing an engine spawns nothing (initialize() does); the assertion runs at the factory.
test("every built-in engine satisfies the contract at the factory", () => {
  for (const id of ["opencode", "omp", "pi"]) {
    assertEngineConformance(createEngine(id))
  }
})

function completeFakeEngine() {
  const engine = {
    id: "fake", label: "Fake",
    capabilities: { questions: true, permissions: true, abort: true }
  }
  for (const method of ENGINE_METHODS) engine[method] = () => {}
  return engine
}

test("conformance failure names the missing method", () => {
  const broken = completeFakeEngine()
  delete broken.prompt
  assert.throws(() => assertEngineConformance(broken), /missing method: prompt/)
})

test("conformance failure names non-boolean capabilities and missing identity", () => {
  const badCapabilities = completeFakeEngine()
  badCapabilities.capabilities.abort = "yes"
  assert.throws(() => assertEngineConformance(badCapabilities), /capabilities\.abort must be a boolean/)
  const noId = completeFakeEngine()
  noId.id = ""
  assert.throws(() => assertEngineConformance(noId), /id must be a non-empty string/)
})

test("conformance rejects non-objects outright", () => {
  assert.throws(() => assertEngineConformance(null), /engine is not an object/)
  assert.throws(() => assertEngineConformance(undefined), /engine is not an object/)
})
