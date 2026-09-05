// bridge/test/gateway-config.test.js
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  loadGatewayConfig,
  expandHome,
  nodeOptionsWithTlsShim,
  provisionEngineConfig,
  resolveStateDir,
  buildOmpModelsYaml,
  buildPiModelsJson,
  buildOpenCodeProviderConfig,
  missingApiKeyEnvWarnings,
  resolveEngineCommand,
  assembleGatewayRuntime
} from "../src/gateway/gateway-config.js"

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
    [{ ...VALID, engines: { omp: { model: "no-slash" } } }, /must look like providerID\/modelID/],
    [{ ...VALID, model: { ...VALID.model, default: "zaicoding/glm-5.2/extra" } }, /model\.default must look like providerID\/modelID/]
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
  const nullModels = structuredClone(VALID)
  nullModels.model.providers.zaicoding.models = null
  withTempConfig(nullModels, (file) => assert.throws(() => loadGatewayConfig({ configPath: file }), /models must be a non-empty object/))
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

test("config carries validated skills and mcp sections", () => {
  withTempConfig({
    skills: [],
    mcp: { fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"] } },
    engines: {}
  }, (file) => {
    const loaded = loadGatewayConfig({ configPath: file })
    assert.deepEqual(loaded.skills, [])
    assert.deepEqual(loaded.mcp.fetch, { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: {} })
  })
})

// 标准形态 + 环境变量引用展开端到端：loadGatewayConfig 的 environment 参数贯穿到 mcp 展开。
test("loadGatewayConfig expands mcp env references and warns about unset variables", () => {
  withTempConfig({
    engines: {},
    mcp: {
      mcpServers: {
        "welink-msg": {
          command: "uvx",
          args: ["--from", "https://x/y.tar.gz", "welink-msg", "stdio"],
          env: { WELINK_TOKEN: "{{WELINK_TOKEN}}" }
        }
      }
    }
  }, (file) => {
    const loaded = loadGatewayConfig({ configPath: file, environment: { WELINK_TOKEN: "demo-token" } })
    assert.deepEqual(loaded.mcp["welink-msg"], {
      type: "local",
      command: ["uvx", "--from", "https://x/y.tar.gz", "welink-msg", "stdio"],
      env: { WELINK_TOKEN: "demo-token" }
    })
    assert.deepEqual(loaded.warnings, [])
    const unset = loadGatewayConfig({ configPath: file, environment: {} })
    assert.equal(unset.mcp["welink-msg"].env.WELINK_TOKEN, "{{WELINK_TOKEN}}")
    assert.deepEqual(unset.warnings, [
      "mcp.welink-msg.env.WELINK_TOKEN references unset environment variable WELINK_TOKEN; the literal reference was kept"
    ])
  })
})

const MODEL = {
  providers: {
    zaicoding: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "{env:ZAI_API_KEY}",
      api: "openai-completions",
      models: { "glm-5.2": { name: "GLM 5.2" } }
    }
  },
  default: "zaicoding/glm-5.2"
}

// OMP 的 PI_CONFIG_DIR 是 home 下的相对目录名，provision 测试的 stateDir 必须建在 home 下。
function relativeName(dir) {
  return path.relative(os.homedir(), dir).split(path.sep).join("/")
}

test("api key references expand per engine", () => {
  const config = { model: MODEL, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwprov-test-"))
  try {
    const oc = provisionEngineConfig("opencode", config, { stateDir })
    assert.equal(oc.env.OPENCODE_CONFIG, path.join(stateDir, "opencode", "opencode.json"))
    const written = JSON.parse(fs.readFileSync(oc.env.OPENCODE_CONFIG, "utf8"))
    assert.equal(written.provider.zaicoding.options.apiKey, "{env:ZAI_API_KEY}")
    assert.equal(written.provider.zaicoding.options.baseURL, "https://api.z.ai/api/coding/paas/v4")
    assert.equal(written.provider.zaicoding.models["glm-5.2"].name, "GLM 5.2")

    const omp = provisionEngineConfig("omp", config, { stateDir })
    assert.equal(omp.env.PI_CONFIG_DIR, `${relativeName(stateDir)}/omp`)
    const ompYaml = fs.readFileSync(omp.files[0], "utf8")
    assert.match(ompYaml, /baseUrl: https:\/\/api\.z\.ai\/api\/coding\/paas\/v4/)
    assert.match(ompYaml, /apiKey: ZAI_API_KEY/)
    assert.match(ompYaml, /- id: glm-5\.2/)
    assert.match(ompYaml, /name: "GLM 5\.2"/)

    const pi = provisionEngineConfig("pi", config, { stateDir })
    assert.equal(pi.env.PI_CODING_AGENT_DIR, path.join(stateDir, "pi", "agent"))
    const piJson = JSON.parse(fs.readFileSync(pi.files[0], "utf8"))
    assert.equal(piJson.providers.zaicoding.apiKey, "$ZAI_API_KEY")
    assert.equal(piJson.providers.zaicoding.api, "openai-completions")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("plaintext api keys pass through to every engine file", () => {
  const config = { model: { ...MODEL, providers: { zaicoding: { ...MODEL.providers.zaicoding, apiKey: "sk-literal" } } }, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwprov-test-"))
  try {
    assert.match(fs.readFileSync(provisionEngineConfig("omp", config, { stateDir }).files[0], "utf8"), /apiKey: sk-literal/)
    assert.equal(JSON.parse(fs.readFileSync(provisionEngineConfig("pi", config, { stateDir }).files[0], "utf8")).providers.zaicoding.apiKey, "sk-literal")
    assert.equal(JSON.parse(fs.readFileSync(provisionEngineConfig("opencode", config, { stateDir }).files[0], "utf8")).provider.zaicoding.options.apiKey, "sk-literal")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("generated engine config files are private (0600)", () => {
  const config = { model: MODEL, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwprov-mode-"))
  try {
    for (const engineId of ["opencode", "omp", "pi"]) {
      const { files } = provisionEngineConfig(engineId, config, { stateDir })
      assert.equal(files.length, 1)
      for (const file of files) {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${engineId} config ${file}`)
      }
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("provision is idempotent and rewrites files", () => {
  const config = { model: MODEL, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwprov-test-"))
  try {
    provisionEngineConfig("opencode", config, { stateDir })
    const first = fs.readFileSync(path.join(stateDir, "opencode", "opencode.json"), "utf8")
    provisionEngineConfig("opencode", config, { stateDir })
    assert.equal(fs.readFileSync(path.join(stateDir, "opencode", "opencode.json"), "utf8"), first)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("empty providers provision is a no-op", () => {
  const config = { model: { providers: {} }, engines: {} }
  assert.deepEqual(provisionEngineConfig("omp", config, { stateDir: "/tmp/x" }), { env: {}, files: [] })
})

test("omp rejects a stateDir outside home (PI_CONFIG_DIR is home-relative)", () => {
  const config = { model: MODEL, engines: {} }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gwout-"))
  try {
    assert.throws(() => provisionEngineConfig("omp", config, { stateDir: outside }), /must live under the home directory/)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("yaml scalar quoting escapes values with specials", () => {
  const yaml = buildOmpModelsYaml({ providers: { p: { baseUrl: "https://x/y?a=b c", apiKey: "k", api: "openai-completions", models: { m1: { name: "Model: #1" } } } } })
  assert.match(yaml, /baseUrl: "https:\/\/x\/y\?a=b c"/)
  assert.match(yaml, /name: "Model: #1"/)
})

test("yaml scalar quoting escapes YAML-coercible bare words", () => {
  const yaml = buildOmpModelsYaml({ providers: { p: { baseUrl: "https://x/y", apiKey: "1234567890", api: "openai-completions", models: { "3.5": { name: "3.5" }, yes: { name: "true" } } } } })
  assert.match(yaml, /apiKey: "1234567890"/)
  assert.match(yaml, /name: "3\.5"/)
  assert.match(yaml, /- id: "3\.5"/)
  assert.match(yaml, /name: "true"/)
  assert.match(yaml, /- id: "yes"/)
  assert.doesNotMatch(yaml, /apiKey: 1234567890/)
})

test("missingApiKeyEnvWarnings lists unset referenced variables", () => {
  const config = { model: MODEL, engines: {} }
  assert.deepEqual(missingApiKeyEnvWarnings(config, { ZAI_API_KEY: "x" }), [])
  const warnings = missingApiKeyEnvWarnings(config, {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ZAI_API_KEY/)
})

test("resolveStateDir honors GATEWAY_STATE_DIR with ~ expansion", () => {
  assert.equal(resolveStateDir({ GATEWAY_STATE_DIR: "~/gwstate" }), path.join(os.homedir(), "gwstate"))
  assert.equal(resolveStateDir({}), path.join(os.homedir(), ".multi-agentengine-gateway"))
})

// resolveEngineCommand 校验绝对路径 command 的存在性，测试用临时目录中的真实文件替代虚构路径。
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwcmd-"))
const OPENCODE_BIN = path.join(binDir, "opencode")
const PI_BIN = path.join(binDir, "pi-acp")
const OMP_BIN = path.join(binDir, "omp")
for (const bin of [OPENCODE_BIN, PI_BIN, OMP_BIN]) fs.writeFileSync(bin, "#!/bin/sh\n")
after(() => fs.rmSync(binDir, { recursive: true, force: true }))

const CONFIG = {
  model: { providers: MODEL.providers, default: "zaicoding/glm-5.2" },
  engines: {
    opencode: { command: OPENCODE_BIN, args: ["--flag"] },
    omp: {},
    pi: { command: PI_BIN, model: "zaicoding/glm-5.2" }
  }
}

test("resolveEngineCommand applies per-engine semantics", () => {
  assert.deepEqual(resolveEngineCommand("opencode", CONFIG, {}), { command: OPENCODE_BIN, args: ["--flag"] })
})

test("resolveEngineCommand returns null without config command", () => {
  assert.equal(resolveEngineCommand("omp", CONFIG, {}), null)
  // 真实安装 optionalDependencies 后默认 repoRoot 会命中本地 pi-acp，用不存在的 repoRoot 保持断言确定性
  assert.equal(resolveEngineCommand("pi", { ...CONFIG, engines: {} }, {}, { repoRoot: "/no/such/root" }), null)
})

test("resolveEngineCommand keeps omp 'acp' and replaces pi npx wrapper", () => {
  const withOmpCommand = { ...CONFIG, engines: { omp: { command: OMP_BIN, args: ["--pre"] } } }
  assert.deepEqual(resolveEngineCommand("omp", withOmpCommand, {}), { command: OMP_BIN, args: ["--pre", "acp"] })
  assert.deepEqual(resolveEngineCommand("pi", CONFIG, {}), { command: PI_BIN, args: [] })
})

test("resolveEngineCommand rejects an absolute command that does not exist", () => {
  const bad = { ...CONFIG, engines: { omp: { command: "/no/such/omp" } } }
  assert.throws(() => resolveEngineCommand("omp", bad, {}), /not found/)
})

test("resolveEngineCommand prefers the project-local pi adapter", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwpil2-"))
  try {
    const bin = path.join(base, "node_modules", ".bin", "pi-acp")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, "#!/bin/sh\n")
    assert.deepEqual(resolveEngineCommand("pi", { engines: {} }, {}, { repoRoot: base }), { command: bin, args: [] })
    assert.equal(resolveEngineCommand("pi", { engines: {} }, {}, { repoRoot: "/no/such/root" }), null)
    // 配置 command 仍然最高优先
    const configured = { engines: { pi: { command: bin } } }
    assert.deepEqual(resolveEngineCommand("pi", configured, {}, { repoRoot: "/no/such/root" }), { command: bin, args: [] })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("assembleGatewayRuntime provisions and resolves model priority", () => {
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwrt-"))
  const provisioned = []
  try {
    const runtime = assembleGatewayRuntime(
      { engine: "pi", defaultModel: "zai/glm-5.2", defaultModelExplicit: false },
      CONFIG,
      {},
      { stateDir, provision: (engineId, config, opts) => { provisioned.push(engineId); return provisionEngineConfig(engineId, config, opts) } }
    )
    assert.deepEqual(provisioned, ["pi"])
    assert.equal(runtime.engineOptions.command, PI_BIN)
    // pi 子进程 env 现在还带 TLS shim 的 NODE_OPTIONS 注入（见 nodeOptionsWithTlsShim）
    assert.equal(runtime.engineOptions.env.PI_CODING_AGENT_DIR, path.join(stateDir, "pi", "agent"))
    assert.match(runtime.engineOptions.env.NODE_OPTIONS, /^--require .*tls-compat-shim\.cjs"$/)
    assert.equal(runtime.defaultModel, "zaicoding/glm-5.2")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("explicit --model / GATEWAY_DEFAULT_MODEL beats config default", () => {
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwrt-"))
  try {
    const explicit = assembleGatewayRuntime(
      { engine: "opencode", defaultModel: "zai/glm-5.2-air", defaultModelExplicit: true },
      CONFIG, {}, { stateDir, provision: () => ({ env: {}, files: [] }) }
    )
    assert.equal(explicit.defaultModel, undefined)
    const unset = assembleGatewayRuntime(
      { engine: "opencode", defaultModel: "zai/glm-5.2", defaultModelExplicit: false },
      { ...CONFIG, engines: {} }, {}, { stateDir, provision: () => ({ env: {}, files: [] }) }
    )
    assert.equal(unset.defaultModel, "zaicoding/glm-5.2")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("assembleGatewayRuntime without config yields empty engineOptions", () => {
  assert.deepEqual(assembleGatewayRuntime({ engine: "opencode" }, null, {}), { engineOptions: {} })
})

function withSkillDir(name, run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwsk-"))
  const skillDir = path.join(base, name)
  fs.mkdirSync(skillDir)
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`)
  try {
    return run(skillDir, base)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("skills-only config provisions omp skills and PI_CONFIG_DIR without models.yml", () => {
  withSkillDir("demo", (skillDir) => {
    const config = { model: { providers: {} }, engines: {}, skills: [{ name: "demo", source: skillDir }], mcp: {} }
    const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwsk-state-"))
    try {
      const result = provisionEngineConfig("omp", config, { stateDir })
      assert.equal(fs.existsSync(path.join(stateDir, "omp", "agent", "models.yml")), false)
      assert.ok(fs.existsSync(path.join(stateDir, "omp", "agent", "skills", "demo", "SKILL.md")))
      assert.equal(result.env.PI_CONFIG_DIR, `${path.relative(os.homedir(), stateDir).split(path.sep).join("/")}/omp`)
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

test("opencode skills inject XDG_CONFIG_HOME and never XDG_DATA_HOME", () => {
  withSkillDir("demo", (skillDir) => {
    const config = { model: { providers: {} }, engines: {}, skills: [{ name: "demo", source: skillDir }], mcp: {} }
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwsk-oc-"))
    try {
      const result = provisionEngineConfig("opencode", config, { stateDir })
      assert.equal(result.env.XDG_CONFIG_HOME, path.join(stateDir, "opencode", "xdg"))
      assert.equal(result.env.XDG_DATA_HOME, undefined)
      assert.ok(fs.existsSync(path.join(stateDir, "opencode", "xdg", "opencode", "skills", "demo", "SKILL.md")))
      assert.equal(result.env.OPENCODE_CONFIG, undefined) // 无 providers 时不写 opencode.json
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

test("providers + skills together keep both env vars and files", () => {
  withSkillDir("demo", (skillDir) => {
    const config = { model: MODEL, engines: {}, skills: [{ name: "demo", source: skillDir }], mcp: {} }
    const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwsk-both-"))
    try {
      const result = provisionEngineConfig("opencode", config, { stateDir })
      assert.equal(result.env.OPENCODE_CONFIG, path.join(stateDir, "opencode", "opencode.json"))
      assert.equal(result.env.XDG_CONFIG_HOME, path.join(stateDir, "opencode", "xdg"))
      const generated = JSON.parse(fs.readFileSync(result.env.OPENCODE_CONFIG, "utf8"))
      assert.ok(generated.provider.zaicoding)
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

test("config with nothing to provision is still a no-op", () => {
  const config = { model: { providers: {} }, engines: {}, skills: [], mcp: {} }
  assert.deepEqual(provisionEngineConfig("omp", config, { stateDir: "/tmp/never" }), { env: {}, files: [] })
})

const MCP_CONFIG = {
  fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: {} },
  context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: {} }
}

test("opencode merges mcp into the generated opencode.json", () => {
  const config = { model: MODEL, engines: {}, skills: [], mcp: MCP_CONFIG }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-oc-"))
  try {
    const result = provisionEngineConfig("opencode", config, { stateDir })
    const generated = JSON.parse(fs.readFileSync(result.env.OPENCODE_CONFIG, "utf8"))
    assert.deepEqual(generated.mcp.fetch, { type: "local", command: ["npx", "-y", "mcp-server-fetch"] })
    assert.equal(generated.mcp.context7.url, "https://mcp.context7.com/mcp")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// 直调形态：loadGatewayConfig 保证 model 段存在，但 provisionEngineConfig 可被直调，
// mcp-only 且 config.model 完全缺失时不得因 buildOpenCodeProviderConfig(undefined) 抛错。
test("opencode mcp-only without a model section writes an mcp-only opencode.json", () => {
  const config = { engines: {}, skills: [], mcp: MCP_CONFIG }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-oc-nomodel-"))
  try {
    const result = provisionEngineConfig("opencode", config, { stateDir })
    assert.equal(result.env.OPENCODE_CONFIG, path.join(stateDir, "opencode", "opencode.json"))
    const generated = JSON.parse(fs.readFileSync(result.env.OPENCODE_CONFIG, "utf8"))
    assert.deepEqual(Object.keys(generated), ["mcp"]) // 只含 mcp 段，无 provider 段
    assert.equal(generated.mcp.fetch.command[0], "npx") // opencode 段保留完整 command 数组
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("omp writes mcp.json beside models.yml", () => {
  const config = { model: MODEL, engines: {}, skills: [], mcp: MCP_CONFIG }
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwmcp-omp-"))
  try {
    provisionEngineConfig("omp", config, { stateDir })
    const mcpJson = JSON.parse(fs.readFileSync(path.join(stateDir, "omp", "agent", "mcp.json"), "utf8"))
    assert.equal(mcpJson.mcpServers.fetch.command, "npx")
    assert.deepEqual(mcpJson.mcpServers.fetch.args, ["-y", "mcp-server-fetch"])
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("pi mcp falls back to a warning without the adapter", () => {
  const config = { model: MODEL, engines: {}, skills: [], mcp: MCP_CONFIG }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-pi-"))
  try {
    const result = provisionEngineConfig("pi", config, { stateDir, repoRoot: "/no/such/root" })
    assert.equal(fs.existsSync(path.join(stateDir, "pi", "agent", "mcp.json")), false)
    assert.equal(result.env.PI_CODING_AGENT_DIR, path.join(stateDir, "pi", "agent")) // models.json 仍生成
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("pi provisioning appends the TLS compat shim to NODE_OPTIONS without clobbering", () => {
  const config = { model: MODEL, engines: {}, skills: [], mcp: {} }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwtls-"))
  try {
    const saved = process.env.NODE_OPTIONS
    try {
      delete process.env.NODE_OPTIONS
      const clean = provisionEngineConfig("pi", config, { stateDir })
      assert.match(clean.env.NODE_OPTIONS, /^--require .*tls-compat-shim\.cjs"$/)
      process.env.NODE_OPTIONS = "--experimental-flag"
      const appended = provisionEngineConfig("pi", config, { stateDir })
      assert.match(appended.env.NODE_OPTIONS, /^--require .*tls-compat-shim\.cjs" --experimental-flag$/)
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = saved
    }
    // 其他引擎不带 NODE_OPTIONS 注入
    const oc = provisionEngineConfig("opencode", config, { stateDir })
    assert.equal(oc.env.NODE_OPTIONS, undefined)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("NODE_OPTIONS shim flag quotes the path so space-containing dirs load", () => {
  const realShim = fileURLToPath(new URL("../src/tls-compat-shim.cjs", import.meta.url))
  const flag = nodeOptionsWithTlsShim({})
  assert.ok(flag.includes(realShim), "flag must embed the shim path")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw quote dir-"))
  try {
    const copiedShim = path.join(dir, "tls-compat-shim.cjs")
    fs.copyFileSync(realShim, copiedShim)
    // 与生产同构的 flag：把真实 shim 路径替换为含空格目录中的副本，注入子进程验证可加载
    const nodeOptions = flag.split(realShim).join(copiedShim)
    const child = spawnSync(process.execPath, ["-e", "console.log('ok')"], {
      env: { ...process.env, NODE_OPTIONS: nodeOptions }
    })
    assert.equal(child.status, 0, `stderr: ${child.stderr}`)
    assert.equal(child.stdout.toString().trim(), "ok")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("NODE_OPTIONS shim path converts backslashes to forward slashes on Windows", () => {
  const windowsPath = "C:\\Users\\test user\\project\\bridge\\src\\tls-compat-shim.cjs"
  const flag = nodeOptionsWithTlsShim({}, { platform: "win32", shimPath: windowsPath })
  assert.equal(flag, '--require "C:/Users/test user/project/bridge/src/tls-compat-shim.cjs"')
  assert.ok(!flag.includes("\\"), "no backslash may survive into NODE_OPTIONS on win32")
  // 非 Windows 平台保持原样：POSIX 文件名允许字面反斜杠，改写会指向另一个文件。
  const kept = nodeOptionsWithTlsShim({}, { platform: "darwin", shimPath: windowsPath })
  assert.equal(kept, `--require "${windowsPath}"`)
})

test("Windows-form shim flag survives Node's NODE_OPTIONS parsing character-for-character", () => {
  // Node 的 NODE_OPTIONS 解析器把引号内的反斜杠当转义符吞掉（"C:\Users\test" → "C:Userstest"），
  // 正斜杠形态必须逐字符无损地到达 --require。C:/ 盘路径在本机（POSIX）不存在，加载必然失败，
  // 错误信息里回显的模块路径即为解析器实际拿到的路径——与原路径一致即证明无损。
  const windowsPath = "C:\\Users\\test user\\project\\bridge\\src\\tls-compat-shim.cjs"
  const flag = nodeOptionsWithTlsShim({}, { platform: "win32", shimPath: windowsPath })
  const child = spawnSync(process.execPath, ["-e", ""], { env: { ...process.env, NODE_OPTIONS: flag } })
  assert.notEqual(child.status, 0, "requiring a nonexistent C:/ path must fail")
  assert.match(
    child.stderr.toString(),
    /Cannot find module 'C:\/Users\/test user\/project\/bridge\/src\/tls-compat-shim\.cjs'/
  )
})

test("assembleGatewayRuntime forwards configured mcp through engineOptions", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwrt-mcp-"))
  try {
    const runtime = assembleGatewayRuntime(
      { engine: "omp" },
      { ...CONFIG, mcp: MCP_CONFIG },
      {},
      { stateDir, provision: () => ({ env: {}, files: [] }) }
    )
    assert.deepEqual(runtime.engineOptions.mcp, MCP_CONFIG)
    const bare = assembleGatewayRuntime(
      { engine: "omp" },
      { ...CONFIG, mcp: {} },
      {},
      { stateDir, provision: () => ({ env: {}, files: [] }) }
    )
    assert.equal(bare.engineOptions.mcp, undefined)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
