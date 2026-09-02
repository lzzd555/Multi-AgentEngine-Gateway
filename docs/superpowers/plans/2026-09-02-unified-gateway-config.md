# 网关统一配置（引擎位置 + 模型注入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关通过单一 `gateway.config.json` 配置模型 provider 与各引擎可执行文件位置，启动时为所选引擎生成隔离配置文件并经环境变量注入，无需用户逐引擎手工配置。

**Architecture:** 新增 `bridge/src/gateway/gateway-config.js`（加载/校验/生成/组装，纯函数为主），`main.js` 启动时加载配置并把 `command/args/env` 组装进 `engineOptions` 传给引擎适配器；OpenCode 链路经 `ManagedOpenCodeHost` 的 `environment` 参数注入 `OPENCODE_CONFIG`，ACP 链路经 `AcpClient` 新增的 `env` 参数注入 `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR`，OMP/PI 的历史加载器与 OMP undo-redo runtime 显式跟随重定向路径。

**Tech Stack:** Node.js ≥20（ACP 适配器路径 ≥22）、纯 ESM、零 npm 依赖、`node --test`。

**Spec:** `docs/superpowers/specs/2026-09-02-unified-gateway-config-design.md`

## Global Constraints

- 网关核心零 npm 依赖；不得违反 import 边界（`bridge/test/gateway-import-boundary.test.js`）
- 无配置文件时全部现有行为不变；注入 env 只作用于引擎子进程，不改网关自身 `process.env`
- OMP 的 `PI_CONFIG_DIR` 必须是 home 下相对名（OMP 源码 `path.join(homedir(), PI_CONFIG_DIR)`，绝对路径会被拼坏）
- PI 的 `PI_CODING_AGENT_DIR` 是绝对路径
- 注入只给当前 `--engine` 所选引擎 provision，每次启动幂等覆盖
- 测试命令统一在 `bridge/` 目录下执行：`node --test test/<file>`；全量 `cd bridge && node --test`
- commit 信息用中文，前缀 `feat:`/`docs:`/`test:`，与仓库现有惯例一致

---

### Task 1: 配置加载与校验（`loadGatewayConfig`）

**Files:**
- Create: `bridge/src/gateway/gateway-config.js`
- Test: `bridge/test/gateway-config.test.js`

**Interfaces:**
- Produces: `expandHome(value)`（`~`/`~/x` 展开，其余原样返回）；`loadGatewayConfig({ configPath, environment = process.env, cwd = process.cwd() })` → `null | { path, model, engines, warnings }`。`model` 形如 `{ providers: { [id]: { baseUrl, apiKey, api, models: { [id]: { name } } } }, default }`，`engines` 形如 `{ [id]: { command?, args?, model? } }`。解析/校验失败抛 `Error`（message 含文件路径与原因）。

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — Cannot find module `../src/gateway/gateway-config.js`

- [ ] **Step 3: Write minimal implementation**

```js
// bridge/src/gateway/gateway-config.js
// 网关统一配置：加载/校验 gateway.config.json；生成三引擎隔离配置并组装启动参数。
// 规格见 docs/superpowers/specs/2026-09-02-unified-gateway-config-design.md
import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

const ENGINE_IDS = ["opencode", "omp", "pi"]
const ALLOWED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"]
const BUILTIN_PROVIDER_FAMILY = new Set(["zai", "zhipu", "bigmodel", "glm"])
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const WIRE_MODEL_PATTERN = /^[^/\s]+\/[^/\s]+$/
export const DEFAULT_STATE_DIRNAME = ".multi-agentengine-gateway"

export function expandHome(value) {
  if (typeof value !== "string") return value
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

export function findGatewayConfigFile({ configPath, environment = process.env, cwd = process.cwd(), existsSync = fs.existsSync }) {
  const explicit = configPath ?? environment.GATEWAY_CONFIG
  if (explicit) return path.resolve(expandHome(explicit))
  const candidate = path.join(cwd, "gateway.config.json")
  return existsSync(candidate) ? candidate : null
}

function readConfigFile(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch (error) {
    throw new Error(`gateway config not readable at ${filePath}: ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`gateway config is not valid JSON (${filePath}): ${error.message}`)
  }
}

function validateProvider(id, definition, sourcePath) {
  if (typeof definition !== "object" || definition === null) throw new Error(`${sourcePath}: model.providers.${id} must be an object`)
  if (typeof definition.baseUrl !== "string" || !/^https?:\/\//.test(definition.baseUrl)) {
    throw new Error(`${sourcePath}: model.providers.${id}.baseUrl must be an http(s) URL`)
  }
  if (typeof definition.apiKey !== "string" || !definition.apiKey) {
    throw new Error(`${sourcePath}: model.providers.${id}.apiKey must be a non-empty string`)
  }
  if (!ALLOWED_APIS.includes(definition.api)) {
    throw new Error(`${sourcePath}: model.providers.${id}.api must be one of ${ALLOWED_APIS.join(", ")}`)
  }
  if (typeof definition.models !== "object" || definition === null || Array.isArray(definition.models) || Object.keys(definition.models).length === 0) {
    throw new Error(`${sourcePath}: model.providers.${id}.models must be a non-empty object`)
  }
  for (const [modelID, meta] of Object.entries(definition.models)) {
    if (typeof meta !== "object" || meta === null) throw new Error(`${sourcePath}: model.providers.${id}.models.${modelID} must be an object`)
  }
}

function validateEngines(engines, providers, sourcePath) {
  if (engines === undefined) return {}
  if (typeof engines !== "object" || engines === null || Array.isArray(engines)) {
    throw new Error(`${sourcePath}: engines must be an object`)
  }
  for (const [id, engine] of Object.entries(engines)) {
    if (!ENGINE_IDS.includes(id)) throw new Error(`${sourcePath}: Unknown engine '${id}'. Available: ${ENGINE_IDS.join(", ")}`)
    if (typeof engine !== "object" || engine === null) throw new Error(`${sourcePath}: engines.${id} must be an object`)
    if (engine.command !== undefined && typeof engine.command !== "string") throw new Error(`${sourcePath}: engines.${id}.command must be a string`)
    if (engine.args !== undefined) {
      if (!Array.isArray(engine.args) || engine.args.some((arg) => typeof arg !== "string")) {
        throw new Error(`${sourcePath}: engines.${id}.args must be an array of strings`)
      }
    }
    if (engine.model !== undefined) {
      if (typeof engine.model !== "string" || !WIRE_MODEL_PATTERN.test(engine.model)) {
        throw new Error(`${sourcePath}: engines.${id}.model must look like providerID/modelID`)
      }
    }
  }
  return engines
}

export function validateGatewayConfig(parsed, sourcePath) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourcePath}: gateway config must be a JSON object`)
  }
  const warnings = []
  const modelSection = parsed.model ?? {}
  if (typeof modelSection !== "object" || modelSection === null) throw new Error(`${sourcePath}: model must be an object`)
  const providerEntries = Object.entries(modelSection.providers ?? {})
  if (modelSection.providers !== undefined && (typeof modelSection.providers !== "object" || modelSection.providers === null)) {
    throw new Error(`${sourcePath}: model.providers must be an object`)
  }
  const providers = {}
  for (const [id, rawDefinition] of providerEntries) {
    if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`${sourcePath}: provider id '${id}' must match ${PROVIDER_ID_PATTERN}`)
    validateProvider(id, rawDefinition, sourcePath)
    if (BUILTIN_PROVIDER_FAMILY.has(id)) {
      warnings.push(`provider id '${id}' collides with an OMP/PI builtin provider family; a distinct id (e.g. 'zaicoding') is recommended`)
    }
    providers[id] = {
      baseUrl: rawDefinition.baseUrl,
      apiKey: rawDefinition.apiKey,
      api: rawDefinition.api,
      models: Object.fromEntries(Object.entries(rawDefinition.models).map(([mid, meta]) => [mid, { name: meta.name ?? mid }]))
    }
  }
  let defaultModel
  if (providerEntries.length > 0) {
    if (typeof modelSection.default !== "string") throw new Error(`${sourcePath}: model.default is required when model.providers is set`)
    const [providerID, modelID] = modelSection.default.split("/")
    if (!providers[providerID]?.models[modelID]) {
      throw new Error(`${sourcePath}: model.default '${modelSection.default}' resolves to no defined provider/model`)
    }
    defaultModel = modelSection.default
  }
  const engines = validateEngines(parsed.engines, providers, sourcePath)
  for (const [id, engine] of Object.entries(engines)) {
    if (engine.command !== undefined) engines[id] = { ...engine, command: expandHome(engine.command) }
  }
  return { model: { providers, default: defaultModel }, engines, warnings }
}

export function loadGatewayConfig({ configPath, environment = process.env, cwd = process.cwd(), readFile = readConfigFile, existsSync = fs.existsSync } = {}) {
  const file = findGatewayConfigFile({ configPath, environment, cwd, existsSync })
  if (!file) return null
  const validated = validateGatewayConfig(readFile(file), file)
  return { path: file, ...validated }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: PASS（全部）

- [ ] **Step 5: Run the full suite for regressions**

Run: `cd bridge && node --test`
Expected: PASS（现有测试无回归）

- [ ] **Step 6: Commit**

```bash
git add bridge/src/gateway/gateway-config.js bridge/test/gateway-config.test.js
git commit -m "feat: 网关统一配置加载与校验（gateway.config.json）"
```

---

### Task 2: 三引擎配置生成与注入（`provisionEngineConfig`）

**Files:**
- Modify: `bridge/src/gateway/gateway-config.js`（追加生成函数）
- Test: `bridge/test/gateway-config.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `loadGatewayConfig` 返回结构。
- Produces:
  - `resolveStateDir(environment = process.env)` → `GATEWAY_STATE_DIR`（`~` 展开）或 `~/.multi-agentengine-gateway`
  - `apiKeyReference(apiKey)` → `{ env: "NAME" } | { literal: "<明文>" }`
  - `buildOpenCodeProviderConfig(model)` → OpenCode `opencode.json` 的对象
  - `buildOmpModelsYaml(model)` → OMP `models.yml` 字符串
  - `buildPiModelsJson(model)` → PI `models.json` 对象
  - `provisionEngineConfig(engineId, config, { stateDir = resolveStateDir(), mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {})` → `{ env: {}, files: [] }`（providers 为空时 no-op）或 `{ env: { OPENCODE_CONFIG | PI_CONFIG_DIR | PI_CODING_AGENT_DIR }, files: [写入路径] }`；OMP 分支在 stateDir 不位于 home 下时抛错
  - `missingApiKeyEnvWarnings(config, environment = process.env)` → `string[]`

- [ ] **Step 1: Write the failing test（追加到 gateway-config.test.js）**

```js
import { provisionEngineConfig, resolveStateDir, buildOmpModelsYaml, buildPiModelsJson, buildOpenCodeProviderConfig, missingApiKeyEnvWarnings } from "../src/gateway/gateway-config.js"

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

test("api key references expand per engine", () => {
  const config = { model: MODEL, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwprov-"))
  try {
    const oc = provisionEngineConfig("opencode", config, { stateDir })
    assert.equal(oc.env.OPENCODE_CONFIG, path.join(stateDir, "opencode", "opencode.json"))
    const written = JSON.parse(fs.readFileSync(oc.env.OPENCODE_CONFIG, "utf8"))
    assert.equal(written.provider.zaicoding.options.apiKey, "{env:ZAI_API_KEY}")
    assert.equal(written.provider.zaicoding.options.baseURL, "https://api.z.ai/api/coding/paas/v4")
    assert.equal(written.provider.zaicoding.models["glm-5.2"].name, "GLM 5.2")

    const omp = provisionEngineConfig("omp", config, { stateDir })
    assert.equal(omp.env.PI_CONFIG_DIR, `${path.basename(stateDir) === stateDir ? stateDir : relativeName(stateDir)}`)
    const ompYaml = fs.readFileSync(omp.files[0], "utf8")
    assert.match(ompYaml, /baseUrl: https:\/\/api\.z\.ai\/api\/coding\/paas\/v4/)
    assert.match(ompYaml, /apiKey: ZAI_API_KEY/)
    assert.match(ompYaml, /- id: glm-5\.2/)
    assert.match(ompYaml, /name: GLM 5\.2/)

    const pi = provisionEngineConfig("pi", config, { stateDir })
    assert.equal(pi.env.PI_CODING_AGENT_DIR, path.join(stateDir, "pi", "agent"))
    const piJson = JSON.parse(fs.readFileSync(pi.files[0], "utf8"))
    assert.equal(piJson.providers.zaicoding.apiKey, "$ZAI_API_KEY")
    assert.equal(piJson.providers.zaicoding.api, "openai-completions")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

function relativeName(dir) {
  return path.relative(os.homedir(), dir)
}

test("plaintext api keys pass through to every engine file", () => {
  const config = { model: { ...MODEL, providers: { zaicoding: { ...MODEL.providers.zaicoding, apiKey: "sk-literal" } } }, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwprov-"))
  try {
    assert.match(fs.readFileSync(provisionEngineConfig("omp", config, { stateDir }).files[0], "utf8"), /apiKey: sk-literal/)
    assert.equal(JSON.parse(fs.readFileSync(provisionEngineConfig("pi", config, { stateDir }).files[0], "utf8")).providers.zaicoding.apiKey, "sk-literal")
    assert.equal(JSON.parse(fs.readFileSync(provisionEngineConfig("opencode", config, { stateDir }).files[0], "utf8")).provider.zaicoding.options.apiKey, "sk-literal")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("provision is idempotent and rewrites files", () => {
  const config = { model: MODEL, engines: {} }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwprov-"))
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
```

注意第一个用例中 `relativeName` 依赖 `os.homedir()` 与临时目录的关系：macOS/Linux 的 `os.tmpdir()`（`/var/folders/...`）不在 home 下，OMP 分支会抛错。因此该用例的 `stateDir` 必须构造在 home 下：

```js
const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".gwprov-test-"))
// ...断言 PI_CONFIG_DIR === path.relative(os.homedir(), stateDir) 的 posix 形式
```

（把上面两个用例里的 `os.tmpdir()` 换成 `os.homedir()`、目录前缀 `.gwprov-test-`；仅"omp rejects outside home"用例保留 tmpdir。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — 不存在 `provisionEngineConfig` 等导出

- [ ] **Step 3: Write minimal implementation（追加到 gateway-config.js）**

```js
export function resolveStateDir(environment = process.env) {
  return expandHome(environment.GATEWAY_STATE_DIR ?? path.join(homedir(), DEFAULT_STATE_DIRNAME))
}

export function apiKeyReference(apiKey) {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKey)
  return match ? { env: match[1] } : { literal: apiKey }
}

export function buildOpenCodeProviderConfig(model) {
  const provider = {}
  for (const [id, definition] of Object.entries(model.providers)) {
    provider[id] = {
      npm: "@ai-sdk/openai-compatible",
      name: id,
      options: { baseURL: definition.baseUrl, apiKey: definition.apiKey },
      models: Object.fromEntries(Object.entries(definition.models).map(([mid, meta]) => [mid, { name: meta.name }]))
    }
  }
  return { provider }
}

// OMP models.yml 是固定两层结构；网关零依赖，不引 YAML 库，这里手写最小序列化。
function yamlScalar(value) {
  const text = String(value)
  return /^[A-Za-z0-9._~:/$-]+$/.test(text) ? text : JSON.stringify(text)
}

export function buildOmpModelsYaml(model) {
  const lines = ["providers:"]
  for (const [id, definition] of Object.entries(model.providers)) {
    const key = apiKeyReference(definition.apiKey)
    lines.push(`  ${id}:`)
    lines.push(`    baseUrl: ${yamlScalar(definition.baseUrl)}`)
    lines.push(`    api: ${yamlScalar(definition.api)}`)
    lines.push(`    apiKey: ${yamlScalar(key.env ?? key.literal)}`)
    lines.push("    models:")
    for (const [mid, meta] of Object.entries(definition.models)) {
      lines.push(`      - id: ${yamlScalar(mid)}`)
      lines.push(`        name: ${yamlScalar(meta.name)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export function buildPiModelsJson(model) {
  const providers = {}
  for (const [id, definition] of Object.entries(model.providers)) {
    const key = apiKeyReference(definition.apiKey)
    providers[id] = {
      baseUrl: definition.baseUrl,
      api: definition.api,
      apiKey: key.env ? `$${key.env}` : key.literal,
      models: Object.entries(definition.models).map(([mid, meta]) => ({ id: mid, name: meta.name }))
    }
  }
  return { providers }
}

// OMP 的 PI_CONFIG_DIR 语义是 home 下的相对目录名（path.join(homedir(), value)），
// 绝对路径会被拼坏，因此 stateDir 必须位于 home 之下（规格 §3）。
function ompConfigDirName(stateDir, home = homedir()) {
  const relative = path.relative(home, stateDir)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`GATEWAY_STATE_DIR must live under the home directory for the OMP engine (PI_CONFIG_DIR is a home-relative name); got ${stateDir}`)
  }
  return relative.split(path.sep).join("/")
}

export function provisionEngineConfig(engineId, config, { stateDir = resolveStateDir(), mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {}) {
  const providers = config?.model?.providers
  if (!providers || Object.keys(providers).length === 0) return { env: {}, files: [] }
  if (engineId === "opencode") {
    const dir = path.join(stateDir, "opencode")
    const file = path.join(dir, "opencode.json")
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(buildOpenCodeProviderConfig(config.model), null, 2)}\n`)
    return { env: { OPENCODE_CONFIG: file }, files: [file] }
  }
  if (engineId === "omp") {
    const dir = path.join(stateDir, "omp", "agent")
    const file = path.join(dir, "models.yml")
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, buildOmpModelsYaml(config.model))
    return { env: { PI_CONFIG_DIR: ompConfigDirName(stateDir) }, files: [file] }
  }
  if (engineId === "pi") {
    const dir = path.join(stateDir, "pi", "agent")
    const file = path.join(dir, "models.json")
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(buildPiModelsJson(config.model), null, 2)}\n`)
    return { env: { PI_CODING_AGENT_DIR: dir }, files: [file] }
  }
  throw new Error(`provisionEngineConfig: unknown engine '${engineId}'`)
}

export function missingApiKeyEnvWarnings(config, environment = process.env) {
  if (!config?.model?.providers) return []
  const warnings = []
  for (const [id, definition] of Object.entries(config.model.providers)) {
    const key = apiKeyReference(definition.apiKey)
    if (key.env && environment[key.env] === undefined) {
      warnings.push(`model.providers.${id}.apiKey references unset environment variable ${key.env}; the engine will fail auth until it is set`)
    }
  }
  return warnings
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/gateway/gateway-config.js bridge/test/gateway-config.test.js
git commit -m "feat: 三引擎隔离配置生成与注入（OPENCODE_CONFIG/PI_CONFIG_DIR/PI_CODING_AGENT_DIR）"
```

---

### Task 3: 启动解析与接线（`--config`、优先级、`main.js` 组装）

**Files:**
- Modify: `bridge/src/gateway/options.js`
- Modify: `bridge/src/gateway/gateway-config.js`（追加 `resolveEngineCommand` / `assembleGatewayRuntime`）
- Modify: `bridge/src/gateway/main.js`
- Test: `bridge/test/gateway-options.test.js`（追加）、`bridge/test/gateway-config.test.js`（追加）

**Interfaces:**
- Consumes: Task 1/2 的 `loadGatewayConfig`、`provisionEngineConfig`、`resolveStateDir`。
- Produces:
  - `parseGatewayOptions` 返回值新增 `configPath`（`--config <path>`）与 `defaultModelExplicit`（`--model` 或 `GATEWAY_DEFAULT_MODEL` 显式给出时为 `true`）
  - `resolveEngineCommand(engineId, config, environment = process.env, { launch } = {})` → `null | { command, args }`；omp 恒追加 `"acp"`，pi 配置 command 即替换 npx 包装（args 原样），opencode args 透传
  - `assembleGatewayRuntime(options, config, environment = process.env, { stateDir, provision = provisionEngineConfig } = {})` → `{ engineOptions: { command?, args?, env? }, defaultModel? }`
  - main.js 在 `parseGatewayOptions` 后：`loadGatewayConfig` → 打印 warnings 与 `missingApiKeyEnvWarnings` → `assembleGatewayRuntime` → `buildGateway({ ...options, defaultModel: runtime.defaultModel ?? options.defaultModel, engineOptions: runtime.engineOptions })`

- [ ] **Step 1: Write the failing test（options 追加）**

```js
// 追加到 bridge/test/gateway-options.test.js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-options.test.js`
Expected: FAIL（`--config` Unknown option / `defaultModelExplicit` undefined）

- [ ] **Step 3: Implement options.js**

`parseGatewayOptions` 内（默认值区）追加：

```js
    configPath: undefined,
    defaultModelExplicit: Boolean(environment.GATEWAY_DEFAULT_MODEL)
```

`--model` 分支处补 `options.defaultModelExplicit = true`；`switch` 追加分支：

```js
      case "--config":
        options.configPath = requireValue(args, index, "--config")
        index += 1
        break
```

`gatewayUsage()` 的 Options 列表追加一行：

```
  --config <path>   Unified gateway config file (default ./gateway.config.json; env GATEWAY_CONFIG)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-options.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing test（resolveEngineCommand / assembleGatewayRuntime，追加到 gateway-config.test.js）**

```js
import { resolveEngineCommand, assembleGatewayRuntime } from "../src/gateway/gateway-config.js"

const CONFIG = {
  model: { providers: MODEL.providers, default: "zaicoding/glm-5.2" },
  engines: {
    opencode: { command: "/opt/opencode/bin/opencode", args: ["--flag"] },
    omp: {},
    pi: { command: "/usr/local/bin/pi-acp", model: "zaicoding/glm-5.2" }
  }
}

test("resolveEngineCommand applies per-engine semantics", () => {
  assert.deepEqual(resolveEngineCommand("opencode", CONFIG, {}), { command: "/opt/opencode/bin/opencode", args: ["--flag"] })
})

test("resolveEngineCommand returns null without config command", () => {
  assert.equal(resolveEngineCommand("omp", CONFIG, {}), null)
  assert.equal(resolveEngineCommand("pi", { ...CONFIG, engines: {} }, {}), null)
})

test("resolveEngineCommand keeps omp 'acp' and replaces pi npx wrapper", () => {
  const withOmpCommand = { ...CONFIG, engines: { omp: { command: "/opt/omp/bin/omp", args: ["--pre"] } } }
  assert.deepEqual(resolveEngineCommand("omp", withOmpCommand, {}), { command: "/opt/omp/bin/omp", args: ["--pre", "acp"] })
  assert.deepEqual(resolveEngineCommand("pi", CONFIG, {}), { command: "/usr/local/bin/pi-acp", args: [] })
})

test("resolveEngineCommand rejects an absolute command that does not exist", () => {
  const bad = { ...CONFIG, engines: { omp: { command: "/no/such/omp" } } }
  assert.throws(() => resolveEngineCommand("omp", bad, {}), /not found/)
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
    assert.equal(runtime.engineOptions.command, "/usr/local/bin/pi-acp")
    assert.deepEqual(runtime.engineOptions.env, { PI_CODING_AGENT_DIR: path.join(stateDir, "pi", "agent") })
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
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — 不存在 `resolveEngineCommand` / `assembleGatewayRuntime`

- [ ] **Step 7: Implement（追加到 gateway-config.js）**

```js
export function resolveEngineCommand(engineId, config, environment = process.env, { existsSync = fs.existsSync } = {}) {
  const engine = config?.engines?.[engineId]
  if (!engine?.command) return null
  const command = engine.command // validateGatewayConfig 已做 ~ 展开
  if (path.isAbsolute(command) && !existsSync(command)) {
    throw new Error(`engines.${engineId}.command not found: ${command}`)
  }
  const userArgs = Array.isArray(engine.args) ? engine.args : []
  const args = engineId === "omp" ? [...userArgs, "acp"] : userArgs
  return { command, args }
}

export function assembleGatewayRuntime(options, config, environment = process.env, { stateDir = resolveStateDir(environment), provision = provisionEngineConfig } = {}) {
  if (!config) return { engineOptions: {} }
  const provisioned = provision(options.engine, config, { stateDir })
  const override = resolveEngineCommand(options.engine, config, environment)
  const engineOptions = { ...(override ?? {}), ...(Object.keys(provisioned.env).length > 0 ? { env: provisioned.env } : {}) }
  let defaultModel
  if (!options.defaultModelExplicit) {
    const configured = config.engines?.[options.engine]?.model ?? config.model?.default
    if (configured) defaultModel = configured
  }
  return { engineOptions, defaultModel }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: PASS

- [ ] **Step 9: Wire main.js**

```js
// bridge/src/gateway/main.js —— import 区追加
import { loadGatewayConfig, missingApiKeyEnvWarnings, assembleGatewayRuntime } from "./gateway-config.js"

// main() 中 parseGatewayOptions/help 之后、buildGateway 之前替换：
  const config = loadGatewayConfig({ configPath: options.configPath })
  if (config) {
    for (const warning of config.warnings) process.stderr.write(`gateway config warning: ${warning}\n`)
    for (const warning of missingApiKeyEnvWarnings(config)) process.stderr.write(`gateway config warning: ${warning}\n`)
  }
  const runtime = assembleGatewayRuntime(options, config, process.env)
  const gateway = buildGateway({
    ...options,
    ...(runtime.defaultModel ? { defaultModel: runtime.defaultModel } : {}),
    engineOptions: runtime.engineOptions
  })
```

- [ ] **Step 10: Manual smoke（无引擎依赖）**

Run: `cd /Users/lzzd/project/Multi-AgentEngine-Gateway && printf '{"engines":{}}' > /tmp/empty-gw.json && node bridge/src/gateway/main.js --config /tmp/no-such.json --port 6217; echo "exit=$?"`
Expected: stderr 报 `gateway config not readable`，`exit=1`；再用 `/tmp/empty-gw.json` 启动应打印 `gateway listening on http://localhost:6217 engine=opencode`（Ctrl-C 退出）。

- [ ] **Step 11: Full suite + commit**

Run: `cd bridge && node --test`
Expected: PASS

```bash
git add bridge/src/gateway/options.js bridge/src/gateway/gateway-config.js bridge/src/gateway/main.js bridge/test/gateway-options.test.js bridge/test/gateway-config.test.js
git commit -m "feat: --config 启动接线与模型/命令优先级组装"
```

---

### Task 4: OpenCode 链路注入（host `extraArgs` + engine `args`/`env` 透传）

**Files:**
- Modify: `bridge/src/opencode-host.js`（构造参数 `extraArgs`，spawn args 追加）
- Modify: `bridge/src/gateway/engines/opencode-engine.js`（按 engineOptions 同名键接收 `args`/`env`/`spawnProcess`/`waitUntilReady`，内部映射给 host）
- Test: `bridge/test/gateway-opencode-engine.test.js`（追加）

**Interfaces:**
- Consumes: Task 3 的 `engineOptions`（`{ command?, args?, env? }`，其中 `env.OPENCODE_CONFIG` 已生成）。
- Produces: `ManagedOpenCodeHost` 构造新增 `extraArgs = []`（追加在 `serve --hostname <h> --port <p>` 之后）；`createOpenCodeEngine` 构造新增 `args = []`（透传为 host `extraArgs`）与 `env = {}`（合并到 `process.env` 之上作为 host spawn 的 `environment`，注入 env 只作用于引擎子进程）、`spawnProcess`/`waitUntilReady`（测试注入）。两个引擎对 engineOptions 的消费键名保持一致：`command`/`args`/`env`。

- [ ] **Step 1: Write the failing test**

```js
// 追加到 bridge/test/gateway-opencode-engine.test.js
import { EventEmitter } from "node:events"

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.pid = 4242
  return child
}

test("engine injects env and args into the managed host spawn", async () => {
  const spawns = []
  const engine = createOpenCodeEngine({
    command: "/opt/opencode/bin/opencode",
    args: ["--flag"],
    env: { OPENCODE_CONFIG: "/tmp/generated/opencode.json" },
    spawnProcess: (command, args, options) => { spawns.push({ command, args, options }); return fakeChild() },
    startTimeoutMs: 5,
    waitUntilReady: async () => {}
  })
  await engine.initialize()
  const spawn = spawns.at(-1)
  assert.equal(spawn.command, "/opt/opencode/bin/opencode")
  assert.deepEqual(spawn.args, ["serve", "--hostname", "127.0.0.1", "--port", "14096", "--flag"])
  assert.equal(spawn.options.env.OPENCODE_CONFIG, "/tmp/generated/opencode.json")
  // env 是叠加在 process.env 之上，而非整体替换
  assert.equal(spawn.options.env.PATH, process.env.PATH)
  await engine.dispose()
})
```

（`waitUntilReady` 是 `ManagedOpenCodeHost` 构造参数；engine 需要透传，见 Step 3。若现有测试文件的 import 没有 `createOpenCodeEngine`，按文件现状补 import。）

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-opencode-engine.test.js`
Expected: FAIL — `args`/`env` 未透传（spawn args 无 `--flag` 或 env 无 `OPENCODE_CONFIG`）

- [ ] **Step 3: Implement**

`opencode-host.js` 构造参数区追加 `extraArgs = []`，保存 `this.extraArgs = extraArgs`；`#start()` 中：

```js
    const invocation = openCodeSpawnInvocation(
      this.command,
      ["serve", "--hostname", this.host, "--port", String(this.port), ...this.extraArgs],
      this.platform,
      this.environment
    )
```

`opencode-engine.js` 构造参数追加 `args = [], env = {}, spawnProcess, waitUntilReady`；`initialize` 中 host 实例化改为：

```js
        managedHost = new ManagedOpenCodeHost({
          command, host, port: upstreamPort, username, password, startTimeoutMs,
          environment: { ...process.env, ...env },
          extraArgs: args,
          ...(spawnProcess ? { spawnProcess } : {}),
          ...(waitUntilReady ? { waitUntilReady } : {})
        })
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-opencode-engine.test.js`
Expected: PASS

- [ ] **Step 5: Full suite + commit**

Run: `cd bridge && node --test`
Expected: PASS

```bash
git add bridge/src/opencode-host.js bridge/src/gateway/engines/opencode-engine.js bridge/test/gateway-opencode-engine.test.js
git commit -m "feat: OpenCode 引擎注入 OPENCODE_CONFIG 与自定义启动参数"
```

---

### Task 5: ACP 链路注入（`AcpClient` env + `acp-engine` 覆盖与重定向）

**Files:**
- Modify: `bridge/src/acp-client.js`（构造参数 `env`，spawn 合并注入）
- Modify: `bridge/src/gateway/engines/acp-engine.js`（`command/args/env` 覆盖 + 历史/undo-redo 重定向）
- Test: `bridge/test/gateway-acp-engine.test.js`（追加）

**Interfaces:**
- Consumes: Task 3 的 `engineOptions`（`{ command?, args?, env? }`，`env.PI_CONFIG_DIR`/`env.PI_CODING_AGENT_DIR` 已生成）。
- Produces:
  - `AcpClient` 构造新增 `env`（对象）；spawn options 变为 `env: this.#env ? { ...process.env, ...this.#env } : undefined`
  - `createAcpEngine` 构造新增 `command`、`args`、`env`；command 存在时跳过 `resolveAcpLaunch`
  - 导出 `redirectProfile(profile, env)`：omp + `PI_CONFIG_DIR` → 重建 `historyLoader`（`~/<PI_CONFIG_DIR>/agent/sessions`）与 `actionProviders`（undo-redo runtime `~/<PI_CONFIG_DIR>/omp-undo-redo/runtime`）；pi + `PI_CODING_AGENT_DIR` → 重建 `historyLoader`（`<dir>/sessions`）；其余原样返回 profile

- [ ] **Step 1: Write the failing test**

```js
// 追加到 bridge/test/gateway-acp-engine.test.js
import path from "node:path"
import os from "node:os"
import { EventEmitter } from "node:events"
import { redirectProfile } from "../src/gateway/engines/acp-engine.js"
import { HARNESS_PROFILES } from "../src/harness-profiles.js"

function fakeAcpChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  return child
}

test("redirectProfile moves omp journals and undo-redo runtime under PI_CONFIG_DIR", () => {
  const redirected = redirectProfile(HARNESS_PROFILES.omp, { PI_CONFIG_DIR: ".multi-agentengine-gateway/omp" })
  assert.notEqual(redirected, HARNESS_PROFILES.omp)
  assert.notEqual(redirected.historyLoader, HARNESS_PROFILES.omp.historyLoader)
  assert.equal(redirected.actionProviders.length, HARNESS_PROFILES.omp.actionProviders.length)
})

test("redirectProfile moves pi sessions under PI_CODING_AGENT_DIR", () => {
  const redirected = redirectProfile(HARNESS_PROFILES.pi, { PI_CODING_AGENT_DIR: "/tmp/gw/pi/agent" })
  assert.ok(redirected.historyLoader)
  assert.equal(redirected.actionProviders, HARNESS_PROFILES.pi.actionProviders)
})

test("redirectProfile returns the profile untouched without matching env", () => {
  assert.equal(redirectProfile(HARNESS_PROFILES.omp, {}), HARNESS_PROFILES.omp)
  assert.equal(redirectProfile(HARNESS_PROFILES.pi, { PI_CONFIG_DIR: "x" }), HARNESS_PROFILES.pi)
})

test("engine passes command override and env injection into the spawned adapter", async () => {
  const spawns = []
  const engine = createAcpEngine({
    profileId: "pi",
    command: "/usr/local/bin/pi-acp",
    args: [],
    env: { PI_CODING_AGENT_DIR: "/tmp/gw/pi/agent" },
    spawnProcess: (command, args, options) => { spawns.push({ command, args, options }); return fakeAcpChild() }
  })
  await assert.rejects(() => engine.initialize())
  const spawn = spawns.at(-1)
  assert.equal(spawn.command, "/usr/local/bin/pi-acp")
  assert.deepEqual(spawn.args, [])
  assert.equal(spawn.options.env.PI_CODING_AGENT_DIR, "/tmp/gw/pi/agent")
  assert.ok(spawn.options.env.PATH !== undefined || Object.keys(spawn.options.env).length > 1)
})
```

说明：`redirectProfile` 的 loader 指向性通过引擎侧行为体现，这里断言"重建了新 loader/provider 而非原对象"；journal 具体路径的正确性由 `createOmpHistoryLoader`/`createPiHistoryLoader` 的 `sessionRoot` 参数构造表达式保证（Task 5 Step 3 中可见）。最后一个用例利用 ACP 握手在 fake child 上必然超时/报错——`assert.rejects` 兜底后检查 spawn 已发生。若 `engine.initialize()` 不因超时而 reject 而是悬挂，改用 `Promise.race([engine.initialize(), new Promise((r) => setTimeout(r, 500, "timeout"))])` 后再断言（`AcpClient#start` 有超时路径）。

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-acp-engine.test.js`
Expected: FAIL — 无 `redirectProfile` 导出；spawn env 无注入

- [ ] **Step 3: Implement acp-client.js**

构造参数追加 `env`，保存 `this.#env = env`；`#start()` spawn options 改为：

```js
    const child = this.#spawn(windowsCommand, windowsArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.#env ? { ...process.env, ...this.#env } : undefined
    })
```

（`env: undefined` 与不传等价，父进程 env 继承，现有测试兼容。）

- [ ] **Step 4: Implement acp-engine.js**

import 区追加：

```js
import { homedir } from "node:os"
import { createOmpHistoryLoader } from "../../omp-session-history.js"
import { createPiHistoryLoader } from "../../pi-session-history.js"
import { createOmpUndoRedoActionStateLoader } from "../../omp-extension-action-state.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "../../extension-actions.js"
```

构造参数追加 `command, args, env`；profile 处理改为：

```js
  const baseProfile = harnessProfile(profileId)
  const profile = redirectProfile(baseProfile, env)
  const launch = command ? { command, args: args ?? [] } : resolveAcpLaunch(baseProfile)
```

`AcpClient` 构造追加 `...(env ? { env } : {})`；新增导出：

```js
// 注入 env 只作用于引擎子进程；OMP/PI 的 journal 与 undo-redo 状态目录由引擎跟随
// PI_CONFIG_DIR / PI_CODING_AGENT_DIR 重定向，网关读取路径必须与子进程写入路径一致。
export function redirectProfile(profile, env) {
  if (!env) return profile
  if (profile.id === "omp" && env.PI_CONFIG_DIR) {
    const root = path.join(homedir(), env.PI_CONFIG_DIR)
    return {
      ...profile,
      historyLoader: createOmpHistoryLoader(path.join(root, "agent", "sessions")),
      actionProviders: OMP_EXTENSION_ACTION_PROVIDERS.map((provider) => ({
        ...provider,
        loadState: createOmpUndoRedoActionStateLoader({ runtimeRoot: path.join(root, "omp-undo-redo", "runtime") })
      }))
    }
  }
  if (profile.id === "pi" && env.PI_CODING_AGENT_DIR) {
    return {
      ...profile,
      historyLoader: createPiHistoryLoader(path.join(env.PI_CODING_AGENT_DIR, "sessions"))
    }
  }
  return profile
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-acp-engine.test.js`
Expected: PASS

- [ ] **Step 6: Full suite + commit**

Run: `cd bridge && node --test`
Expected: PASS

```bash
git add bridge/src/acp-client.js bridge/src/gateway/engines/acp-engine.js bridge/test/gateway-acp-engine.test.js
git commit -m "feat: ACP 引擎命令覆盖与 PI_CONFIG_DIR/PI_CODING_AGENT_DIR 注入及路径重定向"
```

---

### Task 6: 示例配置、文档与实测

**Files:**
- Create: `gateway.config.example.json`（仓库根）
- Modify: `README.md`、`solution/config-templates/README.md`、`solution/INSTRUCTION.md`
- Modify: `docs/superpowers/plans/2026-09-02-unified-gateway-config-run-notes.md`（新建实测记录）

**Interfaces:**
- Consumes: 前五个任务的全部行为。

- [ ] **Step 1: Create the example config**

```json
{
  "$comment": "网关统一配置示例：模型 provider + 各引擎位置。复制为 gateway.config.json 后按需修改。apiKey 支持明文或 {env:NAME} 引用。",
  "model": {
    "providers": {
      "zaicoding": {
        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
        "apiKey": "{env:ZAI_API_KEY}",
        "api": "openai-completions",
        "models": { "glm-5.2": { "name": "GLM 5.2" } }
      }
    },
    "default": "zaicoding/glm-5.2"
  },
  "engines": {
    "opencode": {},
    "omp": {},
    "pi": {}
  }
}
```

- [ ] **Step 2: Update docs**

`README.md` 快速开始改为两步（设置 `ZAI_API_KEY` → 复制示例配置 → 启动），并保留原"引擎侧直配"作为附注；`solution/config-templates/README.md` 顶部新增"网关统一配置（推荐）"一节：配置文件位置与发现顺序、生成目录 `~/.multi-agentengine-gateway/`、三引擎注入变量、`GATEWAY_STATE_DIR` 限制（OMP 要求位于 home 下）；`solution/INSTRUCTION.md` 环境准备第 3 步改为"提供 `gateway.config.json`（见 gateway.config.example.json）并设置 `ZAI_API_KEY`"，原逐引擎配置段标注为可选路径。

- [ ] **Step 3: Full suite + manual rehearsal**

Run: `cd bridge && node --test`
Expected: PASS

准备真实 `gateway.config.json`（GLM5.2、Coding 端点、`{env:ZAI_API_KEY}`）后逐引擎演练并记录：

```bash
export ZAI_API_KEY=<key>
node bridge/src/gateway/main.js --config ./gateway.config.json --engine opencode --port 6217 &
npm run rehearsal
# 依次 --engine omp / --engine pi 重复
```

Expected: 三引擎 rehearsal 均 10/10；OMP/PI 启动后 `~/.multi-agentengine-gateway/{omp,pi}/` 下有生成的配置文件，且不再依赖用户 `~/.omp`/`~/.pi` 的手工模型配置（可在干净 HOME 复验）。

- [ ] **Step 4: Write run-notes and commit**

在 `docs/superpowers/plans/2026-09-02-unified-gateway-config-run-notes.md` 记录实测结果（引擎版本、rehearsal 分数、生成文件清单、遇到的问题）。

```bash
git add gateway.config.example.json README.md solution/config-templates/README.md solution/INSTRUCTION.md docs/superpowers/plans/2026-09-02-unified-gateway-config-run-notes.md
git commit -m "docs: 网关统一配置使用说明、示例与实测记录"
```

---

## Self-Review 结论

- **Spec coverage**：规格 §2（schema/校验/优先级）→ Task 1/3；§3（生成/注入/journal 跟随/YAML）→ Task 2/5；§4（启动接线/命令覆盖/env 只进子进程）→ Task 3/4/5；§5（错误处理矩阵）→ Task 1/2/3 各验证分支；§6（测试）→ 各任务 TDD + Task 6 rehearsal；§7（文档/示例）→ Task 6；§8 非目标未越界。
- **Placeholder scan**：各步骤均含完整代码与预期输出，无占位符。
- **Type consistency**：`engineOptions = { command?, args?, env? }` 在 Task 3 产出、Task 4（opencode：`command/args→extraArgs/env→environment`）与 Task 5（acp：同名直传）消费；`provisionEngineConfig` 返回 `{ env, files }` 在 Task 2/3 一致。
