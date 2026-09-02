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
