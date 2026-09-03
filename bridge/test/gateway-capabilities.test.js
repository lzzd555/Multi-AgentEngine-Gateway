// bridge/test/gateway-capabilities.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { validateSkills, validateMcp, resolveRepoRoot } from "../src/gateway/gateway-capabilities.js"
import { provisionSkills, skillTargets } from "../src/gateway/gateway-capabilities.js"
import { buildOpenCodeMcpSection, buildMcpServersJson, buildAcpMcpServers, provisionPiMcp, piMcpAdapterEntry } from "../src/gateway/gateway-capabilities.js"
import { piLocalCommand } from "../src/gateway/gateway-capabilities.js"

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
    assert.throws(() => validateSkills("not-an-array", "/cfg/c.json"), /must be an array/)
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
  assert.equal(resolveRepoRoot(), path.resolve(import.meta.dirname, "..", ".."))
})

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

// ACP session/new.mcpServers（@agentclientprotocol/sdk v1.4.0）：stdio 无 type 判别字段，env/headers
// 是 {name, value} 数组（omp 端 for...of 迭代），v1 类型必填——空也要输出空数组。
test("buildAcpMcpServers maps normalized mcp onto the ACP session/new union shape", () => {
  assert.deepEqual(buildAcpMcpServers(MCP), [
    { name: "fetch", command: "npx", args: ["-y", "mcp-server-fetch"], env: [{ name: "K", value: "V" }] },
    { name: "context7", type: "http", url: "https://mcp.context7.com/mcp", headers: [{ name: "Auth", value: "B x" }] }
  ])
  assert.deepEqual(buildAcpMcpServers({}), [])
  assert.deepEqual(buildAcpMcpServers({ solo: { type: "local", command: ["srv"], env: {} } }), [
    { name: "solo", command: "srv", args: [], env: [] }
  ])
  assert.deepEqual(buildAcpMcpServers({ bare: { type: "remote", url: "https://x/mcp", headers: {} } }), [
    { name: "bare", type: "http", url: "https://x/mcp", headers: [] }
  ])
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

// settings.json 内容为合法 JSON 但非对象（如 5）时，ESM 严格模式下对原始值属性赋值会抛
// TypeError 崩启动——解析后必须守卫归零为 {} 再合并 extensions。
test("provisionPiMcp survives a non-object settings.json and still writes extensions", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gwad-"))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwst-"))
  try {
    const entry = path.join(base, "node_modules", "pi-mcp-adapter", "dist", "index.js")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "export default {}")
    const agentDir = path.join(stateDir, "pi", "agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "settings.json"), "5")
    const result = provisionPiMcp(MCP, { stateDir, repoRoot: base })
    const settingsFile = path.join(agentDir, "settings.json")
    assert.ok(result.files.includes(settingsFile))
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
    assert.deepEqual(settings, { extensions: [entry] }) // 崩坏内容被替换而非合并
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
