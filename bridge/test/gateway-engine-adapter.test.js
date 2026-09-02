// bridge/test/gateway-engine-adapter.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { createEngine } from "../src/gateway/engines/engine-adapter.js"

test("unknown engine id is rejected with the available list", () => {
  assert.throws(() => createEngine("nope"), /Unknown engine: nope\. Available: opencode, omp, pi/)
})
