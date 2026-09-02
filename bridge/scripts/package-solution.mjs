// bridge/scripts/package-solution.mjs
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const bridgeSrc = path.join(repoRoot, "bridge", "src")
const gatewayEntry = path.join(bridgeSrc, "gateway", "main.js")

function localImports(file) {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)]
    .map((match) => path.resolve(path.dirname(file), match[1]))
    .filter((resolved) => resolved.startsWith(bridgeSrc))
}

function collectClosure(entries) {
  const closure = new Set()
  const queue = [...entries]
  while (queue.length) {
    const file = queue.pop()
    if (closure.has(file) || !existsSync(file)) continue
    closure.add(file)
    queue.push(...localImports(file))
  }
  return [...closure].sort()
}

async function copy(from, to) {
  const info = await stat(from).catch(() => null)
  if (!info) throw new Error(`packaging source missing: ${from}`)
  if (info.isDirectory()) {
    for (const entry of await readdir(from)) {
      await copy(path.join(from, entry), path.join(to, entry))
    }
    return
  }
  await mkdir(path.dirname(to), { recursive: true })
  await writeFile(to, readFileSync(from))
}

async function main() {
  const listOnly = process.argv.includes("--list-deps")
  const closure = collectClosure([gatewayEntry])
  if (listOnly) {
    for (const file of closure) console.log(path.relative(bridgeSrc, file))
    return
  }

  const stageRoot = path.join(repoRoot, ".solution-stage")
  const stage = path.join(stageRoot, "solution")
  const zipTarget = path.join(repoRoot, "solution.zip")
  // Deterministic output: a leftover stage (or a previous zip updated in place) must not
  // leak entries from earlier runs into this package.
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  for (const file of closure) {
    await copy(file, path.join(stage, "code", "bridge", "src", path.relative(bridgeSrc, file)))
  }
  await copy(path.join(repoRoot, "bridge", "package.json"), path.join(stage, "code", "bridge", "package.json"))
  for (const overlay of ["INSTRUCTION.md", "gateway.cmd", "gateway"]) {
    await copy(path.join(repoRoot, "solution", overlay), path.join(stage, overlay))
  }
  // writeFile does not preserve the +x bit; the sh wrapper must stay executable in the zip.
  await chmod(path.join(stage, "gateway"), 0o755)
  await copy(path.join(repoRoot, "solution", "config-templates"), path.join(stage, "code", "solution", "config-templates"))

  await rm(zipTarget, { force: true })
  // Both archivers run with cwd on the stage root and archive the `solution` DIRECTORY so the
  // folder itself becomes the zip root (Windows `...\solution\*` would drop the top level).
  const staged = process.platform === "win32"
    ? spawnSync("powershell", ["-Command",
        `Compress-Archive -Path solution -DestinationPath "${zipTarget}" -Force`], { cwd: stageRoot })
    : spawnSync("zip", ["-r", "-q", zipTarget, "solution"], { cwd: stageRoot })
  if (staged.status !== 0) {
    console.error(staged.stderr?.toString() ?? "zip failed")
    process.exit(1)
  }
  console.log(`packaged ${zipTarget}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
