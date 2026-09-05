import fs from "node:fs"
import path from "node:path"
import { createOmpHistoryLoader } from "./omp-session-history.js"
import { createPiHistoryLoader } from "./pi-session-history.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "./extension-actions.js"

function executableNames(name, platform = process.platform) {
  if (platform !== "win32") return [name]
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  return [name, ...extensions.map((extension) => `${name}${extension}`)]
}

function executable(candidate, { platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  if (!exists(candidate)) return false
  if (platform === "win32") return true
  try {
    access(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findExecutable(name, { pathValue = process.env.PATH ?? "", platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of executableNames(name, platform)) {
      const fullPath = path.join(directory, candidate)
      if (executable(fullPath, { platform, exists, access })) return fullPath
    }
  }
  return null
}

const COMMON_CAPABILITIES = {
  sessions: true,
  prompt: true,
  abort: true,
  streaming: true,
  agents: false,
  diff: false,
  filesystemBrowser: true,
  questions: false,
  permissions: false,
  sessionRename: false,
  sessionDelete: false
}

// 网关只经 createEngine 放行 opencode/omp/pi 三个引擎；历史上迁移自 harness-remote 的
// claude/codex profile 在本仓库运行时不可达，已随 codex-session-history.js 一并移除。
// 若未来接入新 ACP 引擎，在此补 profile 并在 engine-adapter.js 的 createEngine 放行。
export const HARNESS_PROFILES = {
  omp: {
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    args: ["acp"],
    permissionMode: "allow",
    historyLoader: createOmpHistoryLoader(),
    // OMP's journal is the only place a message has a stable identity. Its ACP stream mints a new
    // `messageId` for every live message and mints new ones again on every `session/load` replay,
    // so a Session read once from each source is one conversation with two sets of ids. The journal
    // is therefore the transcript until this bridge takes the writer, and this bridge's own stream
    // is the transcript from then on - never both at once. See AcpService#journalPageWhileOwned.
    journalPageWhileOwned: false,
    // OMP stores a Session's name itself - `/rename` calls `setSessionName(title, "user")`, which
    // writes the title slot and marks it user-set so OMP's own auto-titling leaves it alone. A name
    // kept only in this bridge's snapshot was invisible in the Session index, which reads the
    // harness's lightweight listing, and gone entirely for a Session reopened from OMP.
    nativeRenameCommand: "rename",
    preferListedTitles: true,
    // A transcript that already came from the journal must not be asked for again over ACP, so an
    // owned OMP Session is opened with `session/resume` rather than the replaying `session/load`.
    // Reloading on refresh would reintroduce exactly that replay.
    reloadOnHistoryRefresh: false,
    // OMP exposes thinking as a real ACP config option. We probe only ids the running adapter
    // actually advertises; this list is a routing hint, never a source of invented variants.
    modelVariantConfigIDs: ["thinking"],
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: true,
      actions: true,
      sessionRename: true,
      sessionDelete: true
    },
    actionProviders: OMP_EXTENSION_ACTION_PROVIDERS
  },
  pi: {
    id: "pi",
    label: "PI",
    // @automatalabs/pi-acp embeds PI through its published SDK and runs on Node. Version 0.5.0
    // advertises PI's credential- and provider-filter-aware model catalog directly over ACP, so
    // Harness Remote must not launch a second native `pi` process just to filter membership.
    // npx cannot reliably infer a scoped package's executable from a package spec. Add the package
    // explicitly and invoke the binary the package publishes, otherwise npm may try to execute the
    // literal package spec and exit 127 on a real machine.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "--package=@automatalabs/pi-acp@0.5.0", "pi-acp"],
    adapterCommand: "pi-acp",
    permissionMode: "allow",
    historyLoader: createPiHistoryLoader(),
    preserveListedTimestamps: true,
    // PI journals are authoritative for transcript and title metadata. session/load is a live-session
    // operation and cannot be used as a refresh primitive because PI rejects a second open.
    reloadOnHistoryRefresh: false,
    preferListedTitles: true,
    // Keep the replay tail for the one real session/load used when the bridge takes ownership to prompt.
    replaySettleMs: 250,
    // Current PI ACP calls this `thinkingLevel`. The aliases are harmless compatibility hints for
    // adapter versions that rename the wire id; a variant is emitted only when that option exists.
    modelVariantConfigIDs: ["thinkingLevel", "thinking_level", "thinking"],
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }
}

export function harnessProfile(id) {
  const profile = HARNESS_PROFILES[id]
  if (!profile) throw new Error(`Unsupported backend: ${id}`)
  return profile
}

/**
 * The harness and its ACP adapter are two different installations. `pi` from the project's own
 * installer puts the harness on PATH and no adapter with it, so detecting the harness and then
 * assuming `npx` can fetch an adapter is how a machine with PI installed ends up unable to run PI.
 *
 * An adapter already on PATH is preferred over fetching one: it is what the user installed, it
 * starts without a network round trip, and it sidesteps environments where `npx` cannot link a
 * binary - which is exactly what happens under proot on Android.
 */
export function resolveAcpLaunch(profile, { find = findExecutable } = {}) {
  if (!profile.adapterCommand) return { command: profile.command, args: [...profile.args], source: "harness" }
  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
