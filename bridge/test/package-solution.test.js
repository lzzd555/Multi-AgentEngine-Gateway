// bridge/test/package-solution.test.js
// 打包闭包回归：collectClosure 只跟随 `from "..."` import 边，而 gateway-config.js 经
// new URL("../tls-compat-shim.cjs", import.meta.url) 引用 shim（非 import 边）。shim 漏出闭包会使
// solution.zip 里的 pi 引擎注入 NODE_OPTIONS=--require "<缺失路径>" 而 Node 硬失败。
// 脚本没有可导出接口（import 即执行 main），故以 CLI 子进程跑 --list-deps 解析输出。
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const script = path.resolve(import.meta.dirname, "..", "scripts", "package-solution.mjs")
const bridgeSrc = path.resolve(import.meta.dirname, "..", "src")

function listDeps() {
  const run = spawnSync(process.execPath, [script, "--list-deps"], { encoding: "utf8" })
  assert.equal(run.status, 0, `stderr: ${run.stderr}`)
  return run.stdout.trim().split("\n").map((line) => line.trim()).sort()
}

test("package closure includes the non-import tls-compat-shim.cjs reference", () => {
  const listed = listDeps()
  assert.ok(listed.includes("tls-compat-shim.cjs"),
    `--list-deps must list tls-compat-shim.cjs, got:\n${listed.join("\n")}`)
  // 闭包主体仍在：入口与 shim 的引用方
  assert.ok(listed.includes("gateway/main.js"))
  assert.ok(listed.includes("gateway/gateway-config.js"))
})

test("shim lands next to gateway/ so the packaged gateway-config.js URL resolution finds it", () => {
  const listed = listDeps()
  assert.ok(listed.includes("tls-compat-shim.cjs"))
  // 包内落点：闭包项 → code/bridge/src/<相对 bridgeSrc 项>，与仓库内 bridgeSrc 布局同构。
  // gateway-config.js 以 new URL("../tls-compat-shim.cjs", import.meta.url) 解析 shim，
  // 从其所在位置出发的 URL 解析必须恰好命中闭包种子的落点——仓库内成立即包内成立。
  const gatewayConfig = path.join(bridgeSrc, "gateway", "gateway-config.js")
  const resolvedFromConfig = fileURLToPath(new URL("../tls-compat-shim.cjs", pathToFileURL(gatewayConfig).href))
  assert.equal(resolvedFromConfig, path.join(bridgeSrc, "tls-compat-shim.cjs"))
})
