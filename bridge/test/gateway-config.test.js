// bridge/test/gateway-config.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadGatewayConfig, expandHome } from "../src/gateway/gateway-config.js"

const VALID = {
  model: {
    providers: {
      zaicoding: {
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        apiKey: "{env:ZAI_API_KEY}",
        api: "openai-completions",
        models: { "glm-5.2": { name: "GLM 5.2" } }
      }
    },
    default: "zaicoding/glm-5.2"
  },
  engines: { omp: { command: "~/.local/bin/omp" } }
}

function withTempConfig(content, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwcfg-"))
  const file = path.join(dir, "gateway.config.json")
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  try {
    return run(file, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("expandHome expands ~ and ~/ prefix only", () => {
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"))
  assert.equal(expandHome("~"), os.homedir())
  assert.equal(expandHome("/abs/x"), "/abs/x")
  assert.equal(expandHome("relative"), "relative")
})

test("returns null when no config file is discovered", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gwempty-"))
  try {
    assert.equal(loadGatewayConfig({ environment: {}, cwd: empty }), null)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test("explicit configPath wins over GATEWAY_CONFIG and cwd default", () => {
  withTempConfig(VALID, (file, dir) => {
    const other = path.join(dir, "other.json")
    fs.writeFileSync(other, JSON.stringify({ model: { providers: {}, default: "" }, engines: {} }))
    const loaded = loadGatewayConfig({ configPath: file, environment: { GATEWAY_CONFIG: other }, cwd: dir })
    assert.equal(loaded.path, path.resolve(file))
    assert.ok(loaded.model.providers.zaicoding)
  })
})

test("GATEWAY_CONFIG env var is used when no --config", () => {
  withTempConfig(VALID, (file, dir) => {
    const loaded = loadGatewayConfig({ environment: { GATEWAY_CONFIG: file }, cwd: dir })
    assert.equal(loaded.path, path.resolve(file))
  })
})

test("cwd gateway.config.json is used when nothing explicit", () => {
  withTempConfig(VALID, (file, dir) => {
    const loaded = loadGatewayConfig({ environment: {}, cwd: dir })
    assert.equal(loaded.path, file)
  })
})

test("valid config normalizes and keeps engine ~ paths expanded", () => {
  withTempConfig(VALID, (file) => {
    const loaded = loadGatewayConfig({ configPath: file })
    assert.equal(loaded.engines.omp.command, path.join(os.homedir(), ".local/bin/omp"))
    assert.deepEqual(loaded.warnings, [])
  })
})

test("broken JSON reports the file path", () => {
  withTempConfig("{ nope", (file) => {
    assert.throws(() => loadGatewayConfig({ configPath: file }), new RegExp(file.replace(/[/\\]/g, ".")))
  })
})

test("validation failures are specific", () => {
  const cases = [
    [{ ...VALID, model: { providers: VALID.model.providers } }, /model\.default is required/],
    [{ ...VALID, model: { ...VALID.model, default: "nope/x" } }, /resolves to no defined provider\/model/],
    [{ ...VALID, model: { providers: { "Bad_Id": VALID.model.providers.zaicoding }, default: "Bad_Id/glm-5.2" } }, /provider id .* must match/],
    [{ ...VALID, engines: { turbo: {} } }, /Unknown engine/],
    [{ ...VALID, engines: { omp: { args: "acp" } } }, /args must be an array of strings/],
    [{ ...VALID, engines: { omp: { model: "no-slash" } } }, /must look like providerID\/modelID/]
  ]
  for (const [config, pattern] of cases) {
    withTempConfig(config, (file) => {
      assert.throws(() => loadGatewayConfig({ configPath: file }), pattern, JSON.stringify(config).slice(0, 60))
    })
  }
})

test("provider with bad baseUrl or api is rejected", () => {
  const badUrl = structuredClone(VALID)
  badUrl.model.providers.zaicoding.baseUrl = "ftp://x"
  withTempConfig(badUrl, (file) => assert.throws(() => loadGatewayConfig({ configPath: file }), /baseUrl must be an http/))
  const badApi = structuredClone(VALID)
  badApi.model.providers.zaicoding.api = "grpc"
  withTempConfig(badApi, (file) => assert.throws(() => loadGatewayConfig({ configPath: file }), /api must be one of/))
})

test("builtin zai provider family produces a warning, not an error", () => {
  const config = structuredClone(VALID)
  config.model.providers.zai = { ...config.model.providers.zaicoding }
  config.model.default = "zai/glm-5.2"
  withTempConfig(config, (file) => {
    const loaded = loadGatewayConfig({ configPath: file })
    assert.equal(loaded.warnings.length, 1)
    assert.match(loaded.warnings[0], /zai/)
  })
})

test("empty providers config loads without default", () => {
  withTempConfig({ engines: {} }, (file) => {
    const loaded = loadGatewayConfig({ configPath: file })
    assert.deepEqual(loaded.model.providers, {})
    assert.equal(loaded.model.default, undefined)
  })
})
