// bridge/src/gateway/gateway-capabilities.js
// 网关统一能力供给：skills（SKILL.md 目录复制）与 mcp（三引擎配置生成）的校验与供给。
// 规格见 docs/superpowers/specs/2026-09-03-unified-skills-mcp-design.md
// 自包含不 import ./gateway-config.js（避免循环依赖）；expandTilde 与该模块的 expandHome 语义一致。
import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
}

function expandTilde(value) {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

function isStringRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string")
}

export function validateSkills(skills, sourcePath, { statSync = fs.statSync, existsSync = fs.existsSync } = {}) {
  if (skills === undefined) return []
  if (!Array.isArray(skills) || skills.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${sourcePath}: skills must be an array of non-empty strings`)
  }
  const resolved = []
  const seen = new Set()
  for (const entry of skills) {
    const absolute = path.resolve(path.dirname(sourcePath), expandTilde(entry))
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      throw new Error(`${sourcePath}: skills entry '${entry}' not found: ${absolute}`)
    }
    // 目录与裸 SKILL.md 两种写法统一归一为技能目录（source 恒为目录，下游按目录复制）。
    let name
    let source
    if (stats.isDirectory()) {
      if (!existsSync(path.join(absolute, "SKILL.md"))) {
        throw new Error(`${sourcePath}: skills directory '${entry}' must contain SKILL.md: ${absolute}`)
      }
      name = path.basename(absolute)
      source = absolute
    } else {
      if (path.basename(absolute) !== "SKILL.md") {
        throw new Error(`${sourcePath}: skills file entry '${entry}' must be named SKILL.md: ${absolute}`)
      }
      source = path.dirname(absolute)
      name = path.basename(source)
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`${sourcePath}: skill name '${name}' for entry '${entry}' must match ${SKILL_NAME_PATTERN}`)
    }
    if (seen.has(name)) throw new Error(`${sourcePath}: duplicate skill name '${name}'`)
    seen.add(name)
    resolved.push({ name, source })
  }
  return resolved
}

// mcp 兼容标准 Claude Desktop / mcpServers 形态：外壳剥离 + type 推断 + 字符串 command 归一化。
// 标准形态为 { mcpServers: { <name>: { command: "uvx", args: [...], env: {...} } } }——command 是
// 字符串、args 是独立数组、无 type 字段；网关内部统一归一为 { type, command: string[], env } /
// { type, url, headers }，供给函数（buildOpenCodeMcpSection 等）无需感知输入形态。
export function validateMcp(mcp, sourcePath) {
  if (mcp === undefined) return {}
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error(`${sourcePath}: mcp must be an object`)
  }
  // 外壳剥离："mcpServers" 含大写，永远不可能匹配 MCP_NAME_PATTERN（合法 server 名），出现即按
  // 标准 JSON 外壳处理而非 server 条目。与直接 server 条目混用是配置错误；外壳值非对象时落入
  // 下面的既有校验报错（名字 'mcpServers' 不匹配小写模式）。
  let serverMap = mcp
  if (Object.hasOwn(mcp, "mcpServers")) {
    if (Object.keys(mcp).length > 1) {
      throw new Error(`${sourcePath}: mcp must not mix a 'mcpServers' wrapper with direct server entries`)
    }
    const inner = mcp.mcpServers
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) serverMap = inner
  }
  const normalized = {}
  for (const [name, server] of Object.entries(serverMap)) {
    if (!MCP_NAME_PATTERN.test(name)) throw new Error(`${sourcePath}: mcp server name '${name}' must match ${MCP_NAME_PATTERN}`)
    if (typeof server !== "object" || server === null) throw new Error(`${sourcePath}: mcp.${name} must be an object`)
    // type 可省略：有 command 推断 local，有 url 推断 remote；显式 type 优先。
    const type = server.type !== undefined
      ? server.type
      : server.command !== undefined ? "local" : server.url !== undefined ? "remote" : undefined
    if (type === "local") {
      if (server.env !== undefined && !isStringRecord(server.env)) {
        throw new Error(`${sourcePath}: mcp.${name}.env must be an object of strings`)
      }
      normalized[name] = { type: "local", command: normalizeLocalCommand(server, name, sourcePath), env: { ...(server.env ?? {}) } }
    } else if (type === "remote") {
      if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) {
        throw new Error(`${sourcePath}: mcp.${name}.url must be an http(s) URL`)
      }
      if (server.headers !== undefined && !isStringRecord(server.headers)) {
        throw new Error(`${sourcePath}: mcp.${name}.headers must be an object of strings`)
      }
      normalized[name] = { type: "remote", url: server.url, headers: { ...(server.headers ?? {}) } }
    } else if (server.type !== undefined) {
      throw new Error(`${sourcePath}: mcp.${name}.type must be 'local' or 'remote'`)
    } else {
      throw new Error(`${sourcePath}: mcp.${name} needs either type, command (local), or url (remote)`)
    }
  }
  return normalized
}

// command 归一化：标准形态 command 为非空字符串 + 可选 args 数组，合并为单一数组；数组形态（既有
// 写法）不允许再带独立 args 字段——两种写法并存时参数归属有歧义，直接报错。
function normalizeLocalCommand(server, name, sourcePath) {
  if (Array.isArray(server.command)) {
    if (server.args !== undefined) {
      throw new Error(`${sourcePath}: mcp.${name} uses an array command; put arguments inside it instead of a separate args field`)
    }
    if (server.command.length === 0 || server.command.some((part) => typeof part !== "string" || !part)) {
      throw new Error(`${sourcePath}: mcp.${name}.command must be a non-empty array of strings`)
    }
    return [...server.command]
  }
  if (typeof server.command === "string" && server.command) {
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string" || !arg)) {
        throw new Error(`${sourcePath}: mcp.${name}.args must be an array of non-empty strings`)
      }
      return [server.command, ...server.args]
    }
    return [server.command]
  }
  throw new Error(`${sourcePath}: mcp.${name}.command must be a non-empty array of strings`)
}

// env/headers 值里的环境变量引用：{{VAR}} / ${VAR} / $VAR 三种写法，取值来自网关进程环境。
// 裸 $VAR 按 shell 语义匹配到下一个非名字字符为止（"https://x/$not-a-var" 里的 $not 会命中——
// 标准行为，避免误伤确实想引用 $not 的场景）。
const ENV_REFERENCE_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(?<![\w$])\$([A-Za-z_][A-Za-z0-9_]*)/g

// {{VAR}} / ${VAR} / $VAR 三种引用在 env/headers 值里展开（来自网关进程环境）。
// 引用的变量未设置时保留原样并返回其名，供启动警告——引擎/子进程的错误信息仍可定位。
export function expandEnvReferences(value, environment = process.env) {
  const missing = new Set()
  const expanded = String(value).replace(ENV_REFERENCE_PATTERN, (match, braced, dollar, bare) => {
    const name = braced ?? dollar ?? bare
    return environment[name] !== undefined ? environment[name] : (missing.add(name), match)
  })
  return { value: expanded, missing: [...missing] }
}

// 对校验后的 mcp map 逐值展开 env/headers 引用；未设置的引用保留字面并产出警告（并入
// validateGatewayConfig 的 warnings），供给的三条路径拿到的都是已展开的值。
export function expandMcpEnvReferences(servers, environment = process.env) {
  const warnings = []
  const expanded = {}
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "local") {
      expanded[name] = { ...server, env: expandValueRecord(server.env, `mcp.${name}.env`, environment, warnings) }
    } else {
      expanded[name] = { ...server, headers: expandValueRecord(server.headers, `mcp.${name}.headers`, environment, warnings) }
    }
  }
  return { servers: expanded, warnings }
}

function expandValueRecord(record, label, environment, warnings) {
  const result = {}
  for (const [key, value] of Object.entries(record)) {
    const outcome = expandEnvReferences(value, environment)
    for (const missing of outcome.missing) {
      warnings.push(`${label}.${key} references unset environment variable ${missing}; the literal reference was kept`)
    }
    result[key] = outcome.value
  }
  return result
}

export function skillTargets(engineId, stateDir) {
  if (engineId === "opencode") return { skillsRoot: path.join(stateDir, "opencode", "xdg", "opencode", "skills") }
  if (engineId === "omp") return { skillsRoot: path.join(stateDir, "omp", "agent", "skills") }
  return { skillsRoot: path.join(stateDir, "pi", "agent", "skills") }
}

// 复制而非符号链接：Windows 无特权创建符号链接会 EPERM，且与配置文件"每次启动幂等重同步"同构（规格 §3）。
export function provisionSkills(engineId, skills, { stateDir, cpSync = fs.cpSync, rmSync = fs.rmSync, mkdirSync = fs.mkdirSync } = {}) {
  if (!skills || skills.length === 0) return { files: [] }
  const { skillsRoot } = skillTargets(engineId, stateDir)
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 })
  const files = []
  for (const skill of skills) {
    const target = path.join(skillsRoot, skill.name)
    rmSync(target, { recursive: true, force: true })
    cpSync(skill.source, target, { recursive: true })
    files.push(target)
  }
  return { files }
}

export function buildOpenCodeMcpSection(mcp) {
  const section = {}
  for (const [name, server] of Object.entries(mcp)) {
    section[name] = server.type === "local"
      ? {
          type: "local",
          command: [...server.command],
          ...(Object.keys(server.env).length > 0 ? { environment: { ...server.env } } : {})
        }
      : {
          type: "remote",
          url: server.url,
          ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {})
        }
  }
  return section
}

// OMP（agent/mcp.json）与 PI（pi-mcp-adapter 读 $PI_CODING_AGENT_DIR/mcp.json）共用标准 mcpServers 结构。
export function buildMcpServersJson(mcp) {
  const servers = {}
  for (const [name, server] of Object.entries(mcp)) {
    servers[name] = server.type === "local"
      ? {
          command: server.command[0],
          ...(server.command.length > 1 ? { args: server.command.slice(1) } : {}),
          ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {})
        }
      : {
          type: "http",
          url: server.url,
          ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {})
        }
  }
  return { mcpServers: servers }
}

// ACP session/new.mcpServers 形态，依据安装的 @agentclientprotocol/sdk 1.4.0 v1 类型（dist/schema/
// types.gen.d.ts）与 omp 端 acp-agent 的实际消费代码双重核对：stdio 变体没有 type 判别字段（omp 以
// "command" in server 识别），remote 为 { type: "http", url, headers }。env/headers 在 v1 类型中是必填的
// Array<{name, value}>——omp 端对它做 for...of 迭代（记录形态会直接抛错），空时也必须输出空数组。
export function buildAcpMcpServers(mcp) {
  const servers = []
  for (const [name, server] of Object.entries(mcp)) {
    servers.push(server.type === "local"
      ? {
          name,
          command: server.command[0],
          args: server.command.slice(1),
          env: Object.entries(server.env).map(([key, value]) => ({ name: key, value }))
        }
      : {
          name,
          type: "http",
          url: server.url,
          headers: Object.entries(server.headers).map(([key, value]) => ({ name: key, value }))
        })
  }
  return servers
}

export function piMcpAdapterEntry(repoRoot, { existsSync = fs.existsSync } = {}) {
  // 入口以包的 package.json（main/exports）为准；候选按常见形态排列，找到即用。
  const pkgDir = path.join(repoRoot, "node_modules", "pi-mcp-adapter")
  const manifest = path.join(pkgDir, "package.json")
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"))
      const declared = pkg.main ?? pkg.exports?.["."]?.import ?? pkg.exports?.["."]
      const resolved = typeof declared === "string" ? path.join(pkgDir, declared) : null
      if (resolved && existsSync(resolved)) return resolved
    } catch {
      // manifest 损坏时走下面的固定候选
    }
  }
  const candidates = [path.join(pkgDir, "dist", "index.js"), path.join(pkgDir, "index.js")]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function provisionPiMcp(mcp, { stateDir, repoRoot = resolveRepoRoot(), warn = () => {}, existsSync = fs.existsSync, readFileSync = fs.readFileSync, writeFileSync = fs.writeFileSync, mkdirSync = fs.mkdirSync } = {}) {
  if (Object.keys(mcp).length === 0) return { files: [] }
  const adapterEntry = piMcpAdapterEntry(repoRoot, { existsSync })
  if (!adapterEntry) {
    warn("mcp is configured but the pi engine needs the local pi-mcp-adapter (run npm install); ignoring mcp for this run")
    return { files: [] }
  }
  const agentDir = path.join(stateDir, "pi", "agent")
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const mcpFile = path.join(agentDir, "mcp.json")
  writeFileSync(mcpFile, `${JSON.stringify(buildMcpServersJson(mcp), null, 2)}\n`, { mode: 0o600 })
  // settings.json 合并语义：已有内容（主题、既有 extensions）必须保留，只追加 adapter 入口。
  const settingsFile = path.join(agentDir, "settings.json")
  let settings = {}
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8"))
    } catch {
      settings = {}
    }
    // 内容为合法 JSON 但非对象（如 5）：ESM 严格模式下对原始值属性赋值会抛 TypeError 崩启动。
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {}
  }
  const extensions = new Set(Array.isArray(settings.extensions) ? settings.extensions : [])
  extensions.add(adapterEntry)
  settings.extensions = [...extensions]
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return { files: [mcpFile, settingsFile] }
}

// PI 本地化：optionalDependencies 安装后优先走项目内 pi-acp，消除 npx 首跑网络拉取（规格 §4）。
export function piLocalCommand(repoRoot = resolveRepoRoot(), { existsSync = fs.existsSync, platform = process.platform } = {}) {
  const names = platform === "win32" ? ["pi-acp.cmd", "pi-acp.exe", "pi-acp"] : ["pi-acp"]
  for (const name of names) {
    const candidate = path.join(repoRoot, "node_modules", ".bin", name)
    if (existsSync(candidate)) return { command: candidate, args: [] }
  }
  return null
}
