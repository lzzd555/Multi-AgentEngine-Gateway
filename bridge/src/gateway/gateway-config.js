// bridge/src/gateway/gateway-config.js
// 网关统一配置：加载/校验 gateway.config.json；生成三引擎隔离配置并组装启动参数。
// 规格见 docs/superpowers/specs/2026-09-02-unified-gateway-config-design.md
import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { validateSkills, validateMcp, expandMcpEnvReferences, provisionSkills, provisionPiMcp, buildOpenCodeMcpSection, buildMcpServersJson, resolveRepoRoot, piLocalCommand } from "./gateway-capabilities.js"

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

export function validateGatewayConfig(parsed, sourcePath, environment = process.env) {
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
    if (!WIRE_MODEL_PATTERN.test(modelSection.default)) throw new Error(`${sourcePath}: model.default must look like providerID/modelID`)
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
  // env/headers 值的 {{VAR}}/${VAR}/$VAR 引用在加载时展开（供给的各引擎配置拿到的是最终值）；
  // 引用未设置→保留字面并警告，与 apiKey 未设置警告同一通道（main.js 统一打印 config warnings）。
  const { servers: mcpServers, warnings: mcpWarnings } = expandMcpEnvReferences(validateMcp(parsed.mcp, sourcePath), environment)
  warnings.push(...mcpWarnings)
  return {
    model: { providers, default: defaultModel },
    engines,
    skills: validateSkills(parsed.skills, sourcePath),
    mcp: mcpServers,
    warnings
  }
}

export function loadGatewayConfig({ configPath, environment = process.env, cwd = process.cwd(), readFile = readConfigFile, existsSync = fs.existsSync } = {}) {
  const file = findGatewayConfigFile({ configPath, environment, cwd, existsSync })
  if (!file) return null
  const validated = validateGatewayConfig(readFile(file), file, environment)
  return { path: file, ...validated }
}

export function resolveStateDir(environment = process.env) {
  return expandHome(environment.GATEWAY_STATE_DIR ?? path.join(homedir(), DEFAULT_STATE_DIRNAME))
}

// api.z.ai 平台升级后的 CDN 会静默丢弃携带 X25519MLKEM768 key share 的 TLS ClientHello（Node 24 /
// OpenSSL 3.5 默认发送），纯 Node 的 pi 子进程（pi-acp）因此每次模型调用都 "Request timed out"；
// curl/Bun 引擎不受影响。给子进程的 NODE_OPTIONS 前置 --require tls-compat-shim.cjs，限定经典曲线
// 组即可恢复握手。NODE_OPTIONS 自 Node 12.16 起支持双引号包裹的取值，路径用双引号包起来后，
// 含空格的仓库路径也能经它正确传递，故按 `--require "<path>"` 形式拼接。
export function nodeOptionsWithTlsShim(environment = process.env) {
  const shim = fileURLToPath(new URL("../tls-compat-shim.cjs", import.meta.url))
  const flag = `--require "${shim}"`
  const existing = environment.NODE_OPTIONS
  if (existing && existing.includes("tls-compat-shim")) return existing
  return existing ? `${flag} ${existing}` : flag
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
  if (!/^[A-Za-z0-9._~:/$-]+$/.test(text)) return JSON.stringify(text)
  // YAML 1.1 会把裸的 true/false/null/yes/no/on/off/~/- 与纯数字强转为布尔/空/数值，这些词必须加引号保字符串。
  if (/^(?:true|false|null|yes|no|on|off|~|-)?$/i.test(text) || /^[-+.]?[0-9][0-9_.eE+-]*$/.test(text)) return JSON.stringify(text)
  return text
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

export function provisionEngineConfig(engineId, config, { stateDir = resolveStateDir(), mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync, repoRoot = resolveRepoRoot(), warn = (message) => process.stderr.write(`gateway config warning: ${message}\n`) } = {}) {
  const providers = config?.model?.providers ?? {}
  const hasProviders = Object.keys(providers).length > 0
  const skills = config?.skills ?? []
  const hasSkills = skills.length > 0
  const mcp = config?.mcp ?? {}
  const hasMcp = Object.keys(mcp).length > 0
  if (!hasProviders && !hasSkills && !hasMcp) return { env: {}, files: [] }
  const files = []
  const env = {}
  const addEnv = (entries) => Object.assign(env, entries)
  if (engineId === "opencode") {
    if (hasProviders || hasMcp) {
      const dir = path.join(stateDir, "opencode")
      const file = path.join(dir, "opencode.json")
      // 生成文件可能含明文 API key，目录与文件都必须仅属主可读写。
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const content = {
        // 直调形态下 config.model 可完全缺失（loadGatewayConfig 保证存在）；mcp-only 时
        // 不能让 buildOpenCodeProviderConfig(undefined) 抛错，provider 段仅在非空时并入。
        ...(hasProviders ? { ...buildOpenCodeProviderConfig(config.model) } : {}),
        ...(hasMcp ? { mcp: buildOpenCodeMcpSection(mcp) } : {})
      }
      writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
      files.push(file)
      addEnv({ OPENCODE_CONFIG: file })
    }
    if (hasSkills) {
      files.push(...provisionSkills("opencode", skills, { stateDir }).files)
      // OpenCode 全局 skills 从 XDG 配置目录发现；只重定向 XDG_CONFIG_HOME，auth/数据（XDG_DATA_HOME）不动。
      addEnv({ XDG_CONFIG_HOME: path.join(stateDir, "opencode", "xdg") })
    }
    return { env, files }
  }
  if (engineId === "omp") {
    const dir = path.join(stateDir, "omp", "agent")
    if (hasProviders) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, "models.yml")
      writeFileSync(file, buildOmpModelsYaml(config.model), { mode: 0o600 })
      files.push(file)
    }
    if (hasSkills) files.push(...provisionSkills("omp", skills, { stateDir }).files)
    if (hasMcp) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, "mcp.json")
      writeFileSync(file, `${JSON.stringify(buildMcpServersJson(mcp), null, 2)}\n`, { mode: 0o600 })
      files.push(file)
    }
    if (files.length > 0) {
      // OMP 配置根 = join(homedir(), PI_CONFIG_DIR)，生成文件在其 agent/ 子目录，故相对名需含 /omp。
      addEnv({ PI_CONFIG_DIR: `${ompConfigDirName(stateDir)}/omp` })
    }
    return { env, files }
  }
  if (engineId === "pi") {
    const dir = path.join(stateDir, "pi", "agent")
    if (hasProviders) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, "models.json")
      writeFileSync(file, `${JSON.stringify(buildPiModelsJson(config.model), null, 2)}\n`, { mode: 0o600 })
      files.push(file)
    }
    if (hasSkills) files.push(...provisionSkills("pi", skills, { stateDir }).files)
    if (hasMcp) files.push(...provisionPiMcp(mcp, { stateDir, repoRoot, warn }).files)
    // TLS shim 只为 pi 注入：pi-acp 是纯 Node 子进程（.bin shim 或 npx→node 都会继承 NODE_OPTIONS），
    // 其 Node 24/OpenSSL 3.5 的 MLKEM768 ClientHello 正是被 api.z.ai CDN 丢弃的那个。与
    // PI_CODING_AGENT_DIR 同门（files.length > 0）：统一配置路径之外的场景不碰用户环境。
    if (files.length > 0) addEnv({ PI_CODING_AGENT_DIR: dir, NODE_OPTIONS: nodeOptionsWithTlsShim() })
    return { env, files }
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

export function resolveEngineCommand(engineId, config, environment = process.env, { existsSync = fs.existsSync, repoRoot = resolveRepoRoot() } = {}) {
  const engine = config?.engines?.[engineId]
  if (!engine?.command) {
    if (engineId === "pi") {
      const local = piLocalCommand(repoRoot)
      if (local) return local
    }
    return null
  }
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
  const engineOptions = {
    ...(override ?? {}),
    ...(Object.keys(provisioned.env).length > 0 ? { env: provisioned.env } : {}),
    // omp 的 ACP 模式不从磁盘 mcp.json 发现 MCP（enableMCP:false），只能由网关（ACP 客户端）经
    // session/new.mcpServers 下发；pi/opencode 仍走各自的文件供给路径，收到 mcp 也不消费。
    ...(Object.keys(config.mcp ?? {}).length > 0 ? { mcp: config.mcp } : {})
  }
  let defaultModel
  if (!options.defaultModelExplicit) {
    const configured = config.engines?.[options.engine]?.model ?? config.model?.default
    if (configured) defaultModel = configured
  }
  return { engineOptions, defaultModel }
}
