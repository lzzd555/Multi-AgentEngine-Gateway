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
