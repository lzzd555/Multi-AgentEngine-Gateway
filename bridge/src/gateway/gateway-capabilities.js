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

export function validateMcp(mcp, sourcePath) {
  if (mcp === undefined) return {}
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error(`${sourcePath}: mcp must be an object`)
  }
  const normalized = {}
  for (const [name, server] of Object.entries(mcp)) {
    if (!MCP_NAME_PATTERN.test(name)) throw new Error(`${sourcePath}: mcp server name '${name}' must match ${MCP_NAME_PATTERN}`)
    if (typeof server !== "object" || server === null) throw new Error(`${sourcePath}: mcp.${name} must be an object`)
    if (server.type === "local") {
      if (!Array.isArray(server.command) || server.command.length === 0 || server.command.some((part) => typeof part !== "string" || !part)) {
        throw new Error(`${sourcePath}: mcp.${name}.command must be a non-empty array of strings`)
      }
      if (server.env !== undefined && !isStringRecord(server.env)) {
        throw new Error(`${sourcePath}: mcp.${name}.env must be an object of strings`)
      }
      normalized[name] = { type: "local", command: [...server.command], env: { ...(server.env ?? {}) } }
    } else if (server.type === "remote") {
      if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) {
        throw new Error(`${sourcePath}: mcp.${name}.url must be an http(s) URL`)
      }
      if (server.headers !== undefined && !isStringRecord(server.headers)) {
        throw new Error(`${sourcePath}: mcp.${name}.headers must be an object of strings`)
      }
      normalized[name] = { type: "remote", url: server.url, headers: { ...(server.headers ?? {}) } }
    } else {
      throw new Error(`${sourcePath}: mcp.${name}.type must be 'local' or 'remote'`)
    }
  }
  return normalized
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
