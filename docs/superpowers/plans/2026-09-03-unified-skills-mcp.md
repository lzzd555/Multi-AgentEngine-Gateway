# 网关统一能力供给（Skills + MCP + PI 本地化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gateway.config.json` 新增 `skills`/`mcp` 两段，网关 provision 时把能力同步到所选引擎的隔离位置；PI 引擎与其 MCP adapter 本地化为项目依赖。

**Architecture:** 新模块 `bridge/src/gateway/gateway-capabilities.js` 承载 skills/mcp 的校验、目录供给与 MCP 文件构建（自包含，不与 gateway-config.js 循环依赖）；`gateway-config.js` 的 `validateGatewayConfig` 增加两段校验、`provisionEngineConfig` 重构为按需组装（providers/skills/mcp 任一存在即工作）；PI 启动命令解析增加本地 `node_modules/.bin/pi-acp` 优先探测。

**Tech Stack:** Node.js ≥20（纯 ESM、网关核心零 npm 依赖不变）、`node --test`；新增仓库根 `optionalDependencies`：`@automatalabs/pi-acp@0.5.0`、`pi-mcp-adapter@2.32.1`。

**Spec:** `docs/superpowers/specs/2026-09-03-unified-skills-mcp-design.md`

## Global Constraints

- 工作目录：主检出 `/Users/lzzd/project/Multi-AgentEngine-Gateway`，分支 `feature/unified-skills-mcp`——**不建工作树**（用户明确偏好）
- node 不在默认 PATH，任何 node/npm 命令前先 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`
- 网关核心（`bridge/src/gateway/` 根文件）只允许 `node:` 与 `./` 导入（import 边界测试强制）；skills/mcp 代码在 gateway/ 目录内，遵守同一约束
- skills 用**复制**不用符号链接（Windows 权限 + 供给模型一致性，规格 §3）
- SKILL.md frontmatter 不解析不改动，原样复制
- 未配置 skills/mcp 时行为零变化（现有 105 测试全绿、生成文件内容不变）
- 生成文件/目录权限 0600/0700（沿用现有约定）；skills/mcp 文件不含密钥但沿用同一权限风格
- 基线：`cd bridge && node --test` 105/105 通过
- commit 信息中文，前缀 `feat:`/`docs:`/`fix:`/`test:`

---

### Task 1: 能力段校验（`gateway-capabilities.js` 创建 + `validateGatewayConfig` 集成）

**Files:**
- Create: `bridge/src/gateway/gateway-capabilities.js`
- Modify: `bridge/src/gateway/gateway-config.js`（validateGatewayConfig 返回值增加 skills/mcp）
- Test: `bridge/test/gateway-capabilities.test.js`（新建）、`bridge/test/gateway-config.test.js`（追加）

**Interfaces:**
- Produces:
  - `validateSkills(skills, sourcePath, { statSync, existsSync } = {})` → `[{ name, source }]`（绝对路径已解析、名字已校验唯一）；`skills === undefined` → `[]`
  - `validateMcp(mcp, sourcePath)` → `{ [name]: { type: "local", command: string[], env: {} } | { type: "remote", url, headers: {} } }`（规范化副本）；`mcp === undefined` → `{}`
  - `resolveRepoRoot()` → 仓库根绝对路径（Task 4 消费）
  - `validateGatewayConfig` 返回值新增 `skills`（`[{name, source}]`）与 `mcp`（规范化对象）两个字段

- [ ] **Step 1: Write the failing test（新建 gateway-capabilities.test.js）**

```js
// bridge/test/gateway-capabilities.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { validateSkills, validateMcp, resolveRepoRoot } from "../src/gateway/gateway-capabilities.js"

function withSkill(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwskill-"))
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir)
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\nbody`)
  try {
    return run(skillDir, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const VALID_MCP = {
  fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: { K: "V" } },
  context7: { type: "remote", url: "https://mcp.context7.com/mcp" }
}

test("validateSkills resolves directory entries to {name, source}", () => {
  withSkill("git-release", (skillDir, base) => {
    const resolved = validateSkills([skillDir], "/cfg/gateway.config.json")
    assert.deepEqual(resolved, [{ name: "git-release", source: skillDir }])
  })
})

test("validateSkills accepts a bare SKILL.md path naming its parent directory", () => {
  withSkill("solo", (skillDir) => {
    const resolved = validateSkills([path.join(skillDir, "SKILL.md")], "/cfg/gateway.config.json")
    assert.deepEqual(resolved, [{ name: "solo", source: skillDir }])
  })
})

test("validateSkills expands ~ and resolves relative paths against the config directory", () => {
  withSkill("home-skill", (skillDir) => {
    const home = os.homedir()
    const relInside = path.relative(home, skillDir)
    if (relInside.startsWith("..")) return // tmpdir 不在 home 下时跳过该断言路径
    const resolved = validateSkills([`~/${relInside.split(path.sep).join("/")}`], "/cfg/gateway.config.json")
    assert.equal(resolved[0].name, "home-skill")
  })
  withSkill("rel-skill", (skillDir, base) => {
    const resolved = validateSkills(["./rel-skill"], path.join(base, "gateway.config.json"))
    assert.equal(resolved[0].source, skillDir)
  })
})

test("validateSkills rejects missing paths, missing SKILL.md, wrong filename, bad and duplicate names", () => {
  withSkill("good", (skillDir, base) => {
    assert.throws(() => validateSkills(["/no/such/dir"], "/cfg/c.json"), /not found/)
    const empty = path.join(base, "empty")
    fs.mkdirSync(empty)
    assert.throws(() => validateSkills([empty], "/cfg/c.json"), /must contain SKILL\.md/)
    const stray = path.join(base, "README.md")
    fs.writeFileSync(stray, "x")
    assert.throws(() => validateSkills([stray], "/cfg/c.json"), /must be named SKILL\.md/)
    assert.throws(() => validateSkills([skillDir, skillDir], "/cfg/c.json"), /duplicate skill name/)
    assert.throws(() => validateSkills(["not-an-array"], "/cfg/c.json"), /must be an array/)
  })
  withSkill("Bad_Name", (skillDir) => {
    assert.throws(() => validateSkills([skillDir], "/cfg/c.json"), /must match/)
  })
})

test("validateMcp normalizes both shapes and rejects malformed entries", () => {
  assert.deepEqual(validateMcp(VALID_MCP, "/cfg/c.json"), {
    fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: { K: "V" } },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: {} }
  })
  assert.deepEqual(validateMcp(undefined, "/cfg/c.json"), {})
  const cases = [
    [{ fetch: { type: "local" } }, /command must be a non-empty array/],
    [{ fetch: { type: "local", command: [] } }, /command must be a non-empty array/],
    [{ fetch: { type: "local", command: ["x"], env: "y" } }, /env must be an object/],
    [{ c7: { type: "remote" } }, /url must be an http\(s\) URL/],
    [{ c7: { type: "remote", url: "ftp://x" } }, /url must be an http\(s\) URL/],
    [{ c7: { type: "remote", url: "https://x", headers: 1 } }, /headers must be an object/],
    [{ fetch: { type: "grpc" } }, /type must be 'local' or 'remote'/],
    [{ "Bad Name": { type: "remote", url: "https://x" } }, /must match/],
    ["nope", /must be an object/]
  ]
  for (const [mcp, pattern] of cases) {
    assert.throws(() => validateMcp(mcp, "/cfg/c.json"), pattern, JSON.stringify(mcp))
  }
})

test("resolveRepoRoot points at the repository root", () => {
  assert.equal(resolveRepoRoot(), path.resolve(import.meta.dirname, "..", "..", ".."))
})
```

注意：`import.meta.dirname` 需 Node ≥20.11（本机 v24 满足）；若测试环境更老，改用 `path.dirname(fileURLToPath(import.meta.url))`。

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: FAIL — Cannot find module `../src/gateway/gateway-capabilities.js`

- [ ] **Step 3: Write minimal implementation**

```js
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
    let name
    if (stats.isDirectory()) {
      if (!existsSync(path.join(absolute, "SKILL.md"))) {
        throw new Error(`${sourcePath}: skills directory '${entry}' must contain SKILL.md: ${absolute}`)
      }
      name = path.basename(absolute)
    } else {
      if (path.basename(absolute) !== "SKILL.md") {
        throw new Error(`${sourcePath}: skills file entry '${entry}' must be named SKILL.md: ${absolute}`)
      }
      name = path.basename(path.dirname(absolute))
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`${sourcePath}: skill name '${name}' (from '${entry}') must match ${SKILL_NAME_PATTERN}`)
    }
    if (seen.has(name)) throw new Error(`${sourcePath}: duplicate skill name '${name}'`)
    seen.add(name)
    resolved.push({ name, source: absolute })
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: PASS

- [ ] **Step 5: 集成进 validateGatewayConfig（先写失败测试）**

追加到 `bridge/test/gateway-config.test.js`：

```js
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
```

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — `loaded.skills` 为 undefined

- [ ] **Step 6: 实现（gateway-config.js）**

import 区追加：

```js
import { validateSkills, validateMcp } from "./gateway-capabilities.js"
```

`validateGatewayConfig` 的 `return` 改为：

```js
  return {
    model: { providers, default: defaultModel },
    engines,
    skills: validateSkills(parsed.skills, sourcePath),
    mcp: validateMcp(parsed.mcp, sourcePath),
    warnings
  }
```

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: PASS

- [ ] **Step 7: Full suite + commit**

Run: `cd bridge && node --test`
Expected: 105 + 新增全部通过

```bash
git add bridge/src/gateway/gateway-capabilities.js bridge/src/gateway/gateway-config.js bridge/test/gateway-capabilities.test.js bridge/test/gateway-config.test.js
git commit -m "feat: 统一能力段（skills/mcp）schema 校验"
```

---

### Task 2: Skills 供给（复制 + OpenCode XDG 注入）

**Files:**
- Modify: `bridge/src/gateway/gateway-capabilities.js`（追加 provisionSkills/skillTargets）
- Modify: `bridge/src/gateway/gateway-config.js`（provisionEngineConfig 重构：去早退、接入 skills、OpenCode XDG env）
- Test: `bridge/test/gateway-capabilities.test.js`（追加）、`bridge/test/gateway-config.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `validateSkills` 产物 `[{name, source}]`。
- Produces:
  - `provisionSkills(engineId, skills, { stateDir, cpSync = fs.cpSync, rmSync = fs.rmSync, mkdirSync = fs.mkdirSync } = {})` → `{ files: [目标目录...] }`；空数组 → `{ files: [] }`
  - `skillTargets(engineId, stateDir)` → `{ skillsRoot }`（opencode: `<stateDir>/opencode/xdg/opencode/skills`；omp: `<stateDir>/omp/agent/skills`；pi: `<stateDir>/pi/agent/skills`）
  - `provisionEngineConfig(engineId, config, opts)` 语义变更：providers/skills/mcp（mcp 由 Task 3 接入）任一存在即工作；返回 `env` 按需包含 `OPENCODE_CONFIG`（写了 opencode.json 时）、`XDG_CONFIG_HOME`（opencode 且有 skills 时，值 `<stateDir>/opencode/xdg`）、`PI_CONFIG_DIR`（omp 且写了任一文件时）、`PI_CODING_AGENT_DIR`（pi 且写了任一文件时）

- [ ] **Step 1: Write the failing test（capabilities 追加）**

```js
import { provisionSkills, skillTargets } from "../src/gateway/gateway-capabilities.js"

test("skillTargets maps each engine to its isolated skills root", () => {
  assert.equal(skillTargets("opencode", "/s").skillsRoot, path.join("/s", "opencode", "xdg", "opencode", "skills"))
  assert.equal(skillTargets("omp", "/s").skillsRoot, path.join("/s", "omp", "agent", "skills"))
  assert.equal(skillTargets("pi", "/s").skillsRoot, path.join("/s", "pi", "agent", "skills"))
})

test("provisionSkills copies whole skill dirs, companion files, and resyncs idempotently", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwprov-"))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwstate-"))
  try {
    const skillDir = path.join(base, "git-release")
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: git-release\ndescription: d\n---\nbody")
    fs.writeFileSync(path.join(skillDir, "reference.md"), "companion")
    const result = provisionSkills("omp", [{ name: "git-release", source: skillDir }], { stateDir })
    const target = path.join(stateDir, "omp", "agent", "skills", "git-release")
    assert.deepEqual(result.files, [target])
    assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "---\nname: git-release\ndescription: d\n---\nbody")
    assert.equal(fs.readFileSync(path.join(target, "reference.md"), "utf8"), "companion")
    // 幂等重同步：目标里多出的残留文件在重建后消失
    fs.writeFileSync(path.join(target, "stale.txt"), "old")
    provisionSkills("omp", [{ name: "git-release", source: skillDir }], { stateDir })
    assert.equal(fs.existsSync(path.join(target, "stale.txt")), false)
    // 源删除伴随文件后，目标不残留
    fs.rmSync(path.join(skillDir, "reference.md"))
    provisionSkills("omp", [{ name: "git-release", source: skillDir }], { stateDir })
    assert.equal(fs.existsSync(path.join(target, "reference.md")), false)
    // 空列表 no-op
    assert.deepEqual(provisionSkills("omp", [], { stateDir }), { files: [] })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: FAIL — 不存在 `provisionSkills` 导出

- [ ] **Step 3: Implement（追加到 gateway-capabilities.js）**

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: PASS

- [ ] **Step 5: provisionEngineConfig 集成（先写失败测试，追加到 gateway-config.test.js）**

```js
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
```

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — skills-only 场景被旧的"无 providers 即 no-op"早退跳过

- [ ] **Step 6: 重构 provisionEngineConfig（gateway-config.js）**

import 区追加 `import { provisionSkills } from "./gateway-capabilities.js"`，整个函数替换为：

```js
export function provisionEngineConfig(engineId, config, { stateDir = resolveStateDir(), mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {}) {
  const providers = config?.model?.providers ?? {}
  const hasProviders = Object.keys(providers).length > 0
  const skills = config?.skills ?? []
  const hasSkills = skills.length > 0
  if (!hasProviders && !hasSkills) return { env: {}, files: [] }
  const files = []
  const env = {}
  const addEnv = (entries) => Object.assign(env, entries)
  if (engineId === "opencode") {
    if (hasProviders) {
      const dir = path.join(stateDir, "opencode")
      const file = path.join(dir, "opencode.json")
      // 生成文件可能含明文 API key，目录与文件都必须仅属主可读写。
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file, `${JSON.stringify(buildOpenCodeProviderConfig(config.model), null, 2)}\n`, { mode: 0o600 })
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
    if (files.length > 0) addEnv({ PI_CODING_AGENT_DIR: dir })
    return { env, files }
  }
  throw new Error(`provisionEngineConfig: unknown engine '${engineId}'`)
}
```

Run: `cd bridge && node --test test/gateway-config.test.js && node --test`
Expected: 全部 PASS（含旧用例——OMP 场景 stateDir 在 home 下的既有约定不变）

- [ ] **Step 7: Commit**

```bash
git add bridge/src/gateway/gateway-capabilities.js bridge/src/gateway/gateway-config.js bridge/test/gateway-capabilities.test.js bridge/test/gateway-config.test.js
git commit -m "feat: skills 隔离供给与 OpenCode XDG_CONFIG_HOME 注入"
```

---

### Task 3: MCP 供给（OpenCode 并入 / OMP+PI mcp.json / PI settings 合并）

**Files:**
- Modify: `bridge/src/gateway/gateway-capabilities.js`（追加 builders + provisionPiMcp）
- Modify: `bridge/src/gateway/gateway-config.js`（provisionEngineConfig 接入 mcp）
- Test: `bridge/test/gateway-capabilities.test.js`（追加）、`bridge/test/gateway-config.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的规范化 `mcp` 对象；Task 2 重构后的 provisionEngineConfig 结构。
- Produces:
  - `buildOpenCodeMcpSection(mcp)` → `{ [name]: { type:"local", command, environment? } | { type:"remote", url, headers? } }`
  - `buildMcpServersJson(mcp)` → `{ mcpServers: { [name]: { command, args?, env? } | { type:"http", url, headers? } } }`（OMP/PI 共用）
  - `provisionPiMcp(mcp, { stateDir, repoRoot = resolveRepoRoot(), warn, existsSync, readFileSync, writeFileSync, mkdirSync } = {})` → `{ files }`；adapter 未安装 → 调 `warn(消息)` 并返回 `{ files: [] }`
  - `piMcpAdapterEntry(repoRoot, { existsSync } = {})` → 入口文件绝对路径或 null
  - provisionEngineConfig 的 opencode 分支在生成 opencode.json 时并入 `mcp` 段（有 providers 或 mcp 任一即写文件）；omp 分支 mcp 非空时生成 `mcp.json`；pi 分支 mcp 非空时调 provisionPiMcp

- [ ] **Step 1: Write the failing test（capabilities 追加）**

```js
import { buildOpenCodeMcpSection, buildMcpServersJson, provisionPiMcp, piMcpAdapterEntry } from "../src/gateway/gateway-capabilities.js"

const MCP = {
  fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], env: { K: "V" } },
  context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: { Auth: "B x" } }
}

test("buildOpenCodeMcpSection maps both shapes to the opencode schema", () => {
  assert.deepEqual(buildOpenCodeMcpSection(MCP), {
    fetch: { type: "local", command: ["npx", "-y", "mcp-server-fetch"], environment: { K: "V" } },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: { Auth: "B x" } }
  })
  assert.deepEqual(buildOpenCodeMcpSection({}), {})
})

test("buildMcpServersJson splits local command arrays and maps remote to http", () => {
  assert.deepEqual(buildMcpServersJson(MCP), {
    mcpServers: {
      fetch: { command: "npx", args: ["-y", "mcp-server-fetch"], env: { K: "V" } },
      context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { Auth: "B x" } }
    }
  })
})

test("piMcpAdapterEntry finds the installed adapter entry and misses cleanly", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwad-"))
  try {
    const entry = path.join(base, "node_modules", "pi-mcp-adapter", "dist", "index.js")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "export default {}")
    assert.equal(piMcpAdapterEntry(base), entry)
    assert.equal(piMcpAdapterEntry("/no/such/root"), null)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("provisionPiMcp writes mcp.json and merges settings.json extensions", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwad-"))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwst-"))
  try {
    const entry = path.join(base, "node_modules", "pi-mcp-adapter", "dist", "index.js")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "export default {}")
    const agentDir = path.join(stateDir, "pi", "agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", extensions: ["/existing/ext.js"] }))
    const result = provisionPiMcp(MCP, { stateDir, repoRoot: base })
    const mcpJson = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8"))
    assert.equal(mcpJson.mcpServers.fetch.command, "npx")
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"))
    assert.equal(settings.theme, "dark") // 合并而非覆盖
    assert.deepEqual(settings.extensions, ["/existing/ext.js", entry])
    assert.ok(result.files.includes(path.join(agentDir, "mcp.json")))
    // 权限：mcp.json 0600
    assert.equal(fs.statSync(path.join(agentDir, "mcp.json")).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test("provisionPiMcp warns and skips when the adapter is not installed", () => {
  const warnings = []
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwst-"))
  try {
    const result = provisionPiMcp(MCP, { stateDir, repoRoot: "/no/such/root", warn: (m) => warnings.push(m) })
    assert.deepEqual(result, { files: [] })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /npm install/)
    assert.equal(fs.existsSync(path.join(stateDir, "pi")), false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: FAIL — 不存在四个新导出

- [ ] **Step 3: Implement（追加到 gateway-capabilities.js）**

```js
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
  }
  const extensions = new Set(Array.isArray(settings.extensions) ? settings.extensions : [])
  extensions.add(adapterEntry)
  settings.extensions = [...extensions]
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return { files: [mcpFile, settingsFile] }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bridge && node --test test/gateway-capabilities.test.js`
Expected: PASS

- [ ] **Step 5: provisionEngineConfig 接入 mcp（先写失败测试，追加到 gateway-config.test.js）**

```js
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
```

Run: `cd bridge && node --test test/gateway-config.test.js`
Expected: FAIL — mcp 未接入（opencode.json 无 mcp 段 / omp 无 mcp.json）

- [ ] **Step 6: Implement（gateway-config.js）**

import 区改为 `import { provisionSkills, provisionPiMcp, buildOpenCodeMcpSection, buildMcpServersJson, resolveRepoRoot } from "./gateway-capabilities.js"`；`provisionEngineConfig` 签名增加 `repoRoot = resolveRepoRoot(), warn = (message) => process.stderr.write(\`gateway config warning: ${message}\n\`)`，函数体内：

- 开头新增 `const mcp = config?.mcp ?? {}`、`const hasMcp = Object.keys(mcp).length > 0`，早退条件改为 `if (!hasProviders && !hasSkills && !hasMcp) return { env: {}, files: [] }`
- opencode 分支：`if (hasProviders || hasMcp)` 都写文件，内容为

```js
      const content = {
        ...buildOpenCodeProviderConfig(config.model),
        ...(hasMcp ? { mcp: buildOpenCodeMcpSection(mcp) } : {})
      }
      writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
```

- omp 分支追加：

```js
    if (hasMcp) {
      const file = path.join(stateDir, "omp", "agent", "mcp.json")
      writeFileSync(file, `${JSON.stringify(buildMcpServersJson(mcp), null, 2)}\n`, { mode: 0o600 })
      files.push(file)
    }
```

- pi 分支追加：`if (hasMcp) files.push(...provisionPiMcp(mcp, { stateDir, repoRoot, warn }).files)`

Run: `cd bridge && node --test test/gateway-config.test.js && node --test`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add bridge/src/gateway/gateway-capabilities.js bridge/src/gateway/gateway-config.js bridge/test/gateway-capabilities.test.js bridge/test/gateway-config.test.js
git commit -m "feat: 三引擎 MCP 供给（OpenCode 并入/OMP mcp.json/PI adapter 装配）"
```

---

### Task 4: PI 本地化（optionalDependencies + 本地命令优先）

**Files:**
- Modify: `package.json`（optionalDependencies）
- Modify: `bridge/src/gateway/gateway-capabilities.js`（追加 piLocalCommand）
- Modify: `bridge/src/gateway/gateway-config.js`（resolveEngineCommand pi 本地优先）
- Test: `bridge/test/gateway-capabilities.test.js`（追加）、`bridge/test/gateway-config.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveRepoRoot()`。
- Produces:
  - `piLocalCommand(repoRoot = resolveRepoRoot(), { existsSync = fs.existsSync, platform = process.platform } = {})` → `{ command, args: [] } | null`（探测 `node_modules/.bin/pi-acp[.cmd]`）
  - `resolveEngineCommand` pi 分支：配置 command > 本地 piLocalCommand > null（回落 bridge 默认 npx 链）

- [ ] **Step 1: Write the failing test（capabilities 追加）**

```js
import { piLocalCommand } from "../src/gateway/gateway-capabilities.js"

test("piLocalCommand finds the project-local adapter binary", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwpil-"))
  try {
    assert.equal(piLocalCommand(base), null)
    const bin = path.join(base, "node_modules", ".bin", "pi-acp")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, "#!/bin/sh\n")
    assert.deepEqual(piLocalCommand(base), { command: bin, args: [] })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run to verify it fails / Step 3: Implement**

```js
// PI 本地化：optionalDependencies 安装后优先走项目内 pi-acp，消除 npx 首跑网络拉取（规格 §4）。
export function piLocalCommand(repoRoot = resolveRepoRoot(), { existsSync = fs.existsSync, platform = process.platform } = {}) {
  const names = platform === "win32" ? ["pi-acp.cmd", "pi-acp.exe", "pi-acp"] : ["pi-acp"]
  for (const name of names) {
    const candidate = path.join(repoRoot, "node_modules", ".bin", name)
    if (existsSync(candidate)) return { command: candidate, args: [] }
  }
  return null
}
```

Run: `cd bridge && node --test test/gateway-capabilities.test.js` → PASS

- [ ] **Step 4: resolveEngineCommand 集成（先写失败测试，追加到 gateway-config.test.js）**

```js
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
```

Run: `cd bridge && node --test test/gateway-config.test.js` → FAIL（无 repoRoot 选项、无本地探测）

- [ ] **Step 5: Implement（gateway-config.js）**

`resolveEngineCommand` 签名追加 `repoRoot = resolveRepoRoot()`（与 provisionEngineConfig 一致），在 `if (!engine?.command)` 分支内、`return null` 之前插入：

```js
  if (!engine?.command) {
    if (engineId === "pi") {
      const local = piLocalCommand(repoRoot)
      if (local) return local
    }
    return null
  }
```

import 区把 `piLocalCommand` 加进 capabilities 导入。Run 全套：`cd bridge && node --test` → PASS

- [ ] **Step 6: package.json optionalDependencies + 安装验证**

`package.json` 增加（放在 `"engines"` 之前）：

```json
  "optionalDependencies": {
    "@automatalabs/pi-acp": "0.5.0",
    "pi-mcp-adapter": "2.32.1"
  },
```

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm install --no-fund --no-audit 2>&1 | tail -3 && ls node_modules/.bin/pi-acp && node -e "const p=require('./node_modules/pi-mcp-adapter/package.json');console.log('adapter main:', p.main)"`
Expected: 安装成功（约 268MB，耗时数分钟）；`.bin/pi-acp` 存在；打印 adapter 真实入口（与 piMcpAdapterEntry 的解析互验——若 main 非 dist/index.js 且解析失败，按 Task 6 实测修正候选列表）

- [ ] **Step 7: Full suite + commit**

Run: `cd bridge && node --test`
Expected: 全部 PASS

```bash
git add package.json package-lock.json bridge/src/gateway/gateway-capabilities.js bridge/src/gateway/gateway-config.js bridge/test/gateway-capabilities.test.js bridge/test/gateway-config.test.js
git commit -m "feat: PI 引擎与 pi-mcp-adapter 本地化（optionalDependencies + 本地优先探测）"
```

---

### Task 5: 文档、示例与三引擎实测

**Files:**
- Modify: `gateway.config.example.json`、`README.md`、`solution/config-templates/README.md`、`solution/INSTRUCTION.md`
- Create: `docs/superpowers/plans/2026-09-03-unified-skills-mcp-run-notes.md`、示例 skill `skills/demo-skill/SKILL.md`（含伴随文件，供实测与示例引用）

**Interfaces:**
- Consumes: Task 1-4 的全部行为。

- [ ] **Step 1: 示例 skill（仓库内，可被 example 引用）**

```
skills/demo-skill/SKILL.md:
---
name: demo-skill
description: 网关统一能力供给的演示技能——被要求演示技能时复述本段内容并报出技能名
---
这是 demo-skill 的正文。当用户请求"演示技能"时，回答：技能 demo-skill 已加载，来源为网关统一供给。

skills/demo-skill/reference.md:
（伴随文件，验证整目录复制）
```

`gateway.config.example.json` 的 `engines` 段之前增加：

```json
  "skills": ["./skills/demo-skill"],
  "mcp": {
    "fetch": { "type": "local", "command": ["npx", "-y", "mcp-server-fetch"] }
  },
```

- [ ] **Step 2: 文档更新**

- `solution/config-templates/README.md` 统一配置节追加：skills（路径引用、目录名规则、复制语义）与 mcp（local/remote、三引擎映射表：OpenCode 并入生成文件 / OMP agent/mcp.json / PI 需 `npm install` 装 adapter 未装则警告忽略）说明；如实标注 OMP remote 形态与 PI adapter 兼容性两个验证项的状态
- `README.md`：快速开始加入 `npm install`（PI 本地化，未装回落 npx）；特性列表补 skills/mcp 一行
- `solution/INSTRUCTION.md`：环境准备 PI 行从"无需单独安装"改为"`npm install` 本地化（可选；未装时 npx 兜底）"
- `gateway.config.json`（用户本地，gitignored）若存在则提醒用户可增补 skills/mcp 段——不代改

- [ ] **Step 3: 全量测试 + 三引擎实测（有 ZAI_API_KEY）**

Run: `cd bridge && node --test`（全绿后）

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
export ZAI_API_KEY=<用户环境提供>
cp gateway.config.example.json /tmp/skills-mcp-test.json  # 或直接用仓库 gateway.config.json 增补两段
# 逐引擎：验证启动日志无异常、rehearsal、skill 与 MCP 生效
node bridge/src/gateway/main.js --config /tmp/skills-mcp-test.json --engine opencode --port 6217 &
npm run rehearsal        # 预期 10/10
ls ~/.multi-agentengine-gateway/opencode/xdg/opencode/skills/
kill %1
# --engine omp：同上，另查 ~/.multi-agentengine-gateway/omp/agent/{skills,mcp.json}
# --engine pi：同上，另查 ~/.multi-agentengine-gateway/pi/agent/{skills,mcp.json,settings.json}
```

skill 生效验证（对话探针，经网关 prompt）：问"请演示技能"，预期回答含 `demo-skill`；MCP 生效验证：OpenCode 日志/OMP 启动输出中 mcp-server-fetch 被拉起（或对话中请求调用 fetch 工具）。PI 侧验证 adapter 与内嵌 pi 0.84.2 兼容——不兼容则 pin 旧版 adapter（`npm view pi-mcp-adapter versions` 选与 0.84.2 同期版本）并回填规格 §4。OMP remote 形态同法验证，不支持则按规格 §5 降级。

- [ ] **Step 4: run-notes + commit**

`docs/superpowers/plans/2026-09-03-unified-skills-mcp-run-notes.md` 记录：三引擎 rehearsal 结果、skill/MCP 生效证据、PI adapter 兼容性结论（含 pin 决定）、OMP remote 结论、遗留问题。

```bash
git add gateway.config.example.json README.md solution/config-templates/README.md solution/INSTRUCTION.md skills/ docs/superpowers/plans/2026-09-03-unified-skills-mcp-run-notes.md
git commit -m "docs: 能力供给示例、说明与三引擎实测记录"
```

---

## Self-Review 结论

- **Spec coverage**：规格 §2（schema/校验）→ Task 1；§3（skills 供给/XDG）→ Task 2；§4（PI 本地化/优先级/optionalDependencies/兼容性验证）→ Task 4 + Task 5 实测；§5（MCP 三引擎/合并语义/回落）→ Task 3 + Task 5 实测；§6（错误处理）→ Task 1/2/3 各验证分支；§7（测试矩阵）→ 各任务 TDD + Task 5；§8（文档）→ Task 5；§9 非目标未越界。
- **Placeholder scan**：无占位符；adapter 入口经 package.json manifest 解析 + 固定候选双保险，Task 4 Step 6 与 Task 5 Step 3 各有一次实测互验点。
- **Type consistency**：`skills: [{name, source}]`、`mcp: { [name]: {type,command,env|url,headers} }` 在 Task 1 产出、Task 2/3 消费；`provisionEngineConfig` 返回 `{env, files}` 不变；`repoRoot`/`warn` 选项在 Task 3/4 的 provisionEngineConfig 与 resolveEngineCommand 签名间一致。
