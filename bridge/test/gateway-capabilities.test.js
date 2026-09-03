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
