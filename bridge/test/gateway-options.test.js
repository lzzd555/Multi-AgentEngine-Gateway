// bridge/test/gateway-options.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseGatewayOptions, gatewayUsage } from "../src/gateway/options.js"

test("defaults match the gateway spec", () => {
  const options = parseGatewayOptions([], {})
  assert.equal(options.engine, "opencode")
  assert.equal(options.host, "localhost")
  assert.equal(options.port, 6217)
  assert.equal(options.defaultModel, "zai/glm-5.2")
})

test("--engine and --port args win over environment", () => {
  const options = parseGatewayOptions(["--engine", "pi", "--port", "7000"], { ENGINE: "omp" })
  assert.equal(options.engine, "pi")
  assert.equal(options.port, 7000)
})

test("environment variables set engine and model", () => {
  const options = parseGatewayOptions([], { ENGINE: "omp", GATEWAY_DEFAULT_MODEL: "zai/glm-5.2-air" })
  assert.equal(options.engine, "omp")
  assert.equal(options.defaultModel, "zai/glm-5.2-air")
})

test("HARNESS_REMOTE_BACKEND is honored as a fallback", () => {
  assert.equal(parseGatewayOptions([], { HARNESS_REMOTE_BACKEND: "pi" }).engine, "pi")
})

test("AGENT_ENGINE from the debug guide wins over other engine env vars", () => {
  assert.equal(parseGatewayOptions([], { AGENT_ENGINE: "pi", ENGINE: "omp" }).engine, "pi")
  assert.equal(parseGatewayOptions([], { AGENT_ENGINE: "omp" }).engine, "omp")
})

test("usage mentions AGENT_ENGINE", () => {
  assert.match(gatewayUsage(), /AGENT_ENGINE/)
})

test("invalid port and unknown option are rejected", () => {
  assert.throws(() => parseGatewayOptions(["--port", "70000"], {}), /between 1 and 65535/)
  assert.throws(() => parseGatewayOptions(["--wat"], {}), /Unknown option/)
})

test("usage mentions engine and port", () => {
  assert.match(gatewayUsage(), /--engine/)
  assert.match(gatewayUsage(), /6217/)
})

test("--config sets configPath and requires a value", () => {
  const options = parseGatewayOptions(["--config", "/tmp/gw.json"], {})
  assert.equal(options.configPath, "/tmp/gw.json")
  assert.throws(() => parseGatewayOptions(["--config"], {}), /--config requires a value/)
})

test("defaultModelExplicit reflects cli/env overrides only", () => {
  assert.equal(parseGatewayOptions([], {}).defaultModelExplicit, false)
  assert.equal(parseGatewayOptions([], { GATEWAY_DEFAULT_MODEL: "zai/glm-5.2-air" }).defaultModelExplicit, true)
  assert.equal(parseGatewayOptions(["--model", "zai/x"], {}).defaultModelExplicit, true)
})

test("usage mentions --config", () => {
  assert.match(gatewayUsage(), /--config/)
})
