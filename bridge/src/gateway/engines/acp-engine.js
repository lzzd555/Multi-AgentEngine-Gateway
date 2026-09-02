// bridge/src/gateway/engines/acp-engine.js
// The ACP engine wraps the bridge's existing ACP stack (AcpClient + AcpService, configured by a
// harness profile) behind the gateway's Engine contract. One adapter serves every ACP harness;
// the profile is the only difference. ACP asks no questions, and its permissions are parked on
// the gateway's interaction queue: the request stays open until the judge replies over HTTP.
import path from "node:path"
import { AcpClient } from "../../acp-client.js"
import { AcpService } from "../../acp-service.js"
import { harnessProfile, resolveAcpLaunch } from "../../harness-profiles.js"
import { normalizeAcpMessages } from "./normalize-acp.js"

const ACP_CAPABILITIES = { questions: false, permissions: true, abort: true }

export function createAcpEngine({
  profileId,
  acp,
  service,
  stateDirectory,
  spawnProcess,
  permissionBridge
} = {}) {
  const profile = harnessProfile(profileId)
  const launch = resolveAcpLaunch(profile)
  const listeners = new Set()
  const seenParts = new Map() // `${sessionID}:${messageID}` → JSON of last-seen normalized parts
  const sessionStatuses = new Map() // sessionID → "idle" | "busy" (sessions this engine reported)
  let askPermissionHook = permissionBridge?.askPermission

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // listener errors must not break the engine
      }
    }
  }

  const client = acp ?? new AcpClient({
    command: launch.command,
    args: launch.args,
    permissionMode: profile.permissionMode,
    preferredAuthMethod: profile.authMethod,
    ...(spawnProcess ? { spawnProcess } : {}),
    // Park every permission ask on the gateway queue; the judge replies over HTTP.
    permissionHandler: async ({ sessionId, options }) => {
      if (!askPermissionHook) return null
      const record = {
        sessionID: sessionId,
        permission: options[0]?.kind?.startsWith("allow") ? "tool.execute" : options[0]?.kind ?? "permission",
        patterns: options.map((option) => option.name ?? option.kind).filter(Boolean)
      }
      const { settled } = askPermissionHook(record)
      const answer = await settled
      return permissionDecision(answer ?? {}, options)
    }
  })

  const engineService = service ?? new AcpService(client, {
    snapshotDirectory: stateDirectory ? path.join(stateDirectory, profile.id) : undefined,
    historyLoader: profile.historyLoader,
    preserveListedTimestamps: profile.preserveListedTimestamps,
    reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
    replaySettleMs: profile.replaySettleMs,
    preferListedTitles: profile.preferListedTitles,
    nativeRenameCommand: profile.nativeRenameCommand,
    journalPageWhileOwned: profile.journalPageWhileOwned,
    modelVariantConfigIDs: profile.modelVariantConfigIDs,
    actionProviders: profile.actionProviders
  })

  function statusOf(sessionID) {
    return engineService.status(sessionID)?.type ?? "idle"
  }

  // One message.part.updated per changed or added normalized part index; a part that disappeared
  // is not reported, because the spec has no part-removal event and the next full read covers it.
  async function emitPartUpdates(sessionID) {
    const messages = await engineService.messages(sessionID, false).catch(() => [])
    const busy = statusOf(sessionID) === "busy"
    for (const message of messages ?? []) {
      const key = `${sessionID}:${message.info?.id}`
      const normalizedParts = normalizeAcpMessages([message], { busy })[0]?.parts ?? []
      const previous = seenParts.get(key) ?? "[]"
      const current = JSON.stringify(normalizedParts)
      if (current === previous) continue
      seenParts.set(key, current)
      const previousList = JSON.parse(previous)
      normalizedParts.forEach((part, index) => {
        if (JSON.stringify(part) !== JSON.stringify(previousList[index] ?? null)) {
          emit({ type: "message.part.updated", properties: { sessionID, messageID: message.info.id, part } })
        }
      })
    }
  }

  const unsubscribeService = engineService.subscribe((event) => {
    if (event.type === "session.updated" || event.type === "session.created") {
      const status = statusOf(event.sessionId)
      const previous = sessionStatuses.get(event.sessionId)
      sessionStatuses.set(event.sessionId, status)
      emit({ type: "session.status", properties: { sessionID: event.sessionId, status: { type: status } } })
      if (previous === "busy" && status === "idle") {
        emit({ type: "session.idle", properties: { sessionID: event.sessionId } })
      }
      return
    }
    if (event.type === "session.deleted") {
      sessionStatuses.delete(event.sessionId)
      for (const key of seenParts.keys()) {
        if (key.startsWith(`${event.sessionId}:`)) seenParts.delete(key)
      }
      return
    }
    if (event.type === "session.error") {
      emit({ type: "session.error", properties: { sessionID: event.sessionId, error: { message: event.message ?? "engine error" } } })
      return
    }
    if (event.type === "message.updated") {
      void emitPartUpdates(event.sessionId).catch(() => {})
    }
  })

  return {
    id: profile.id,
    label: profile.label,
    capabilities: ACP_CAPABILITIES,

    async initialize() {
      if (!acp) await client.start()
    },

    async dispose() {
      unsubscribeService()
      await engineService.flushSnapshots?.()
      client.close?.()
    },

    onInteraction({ askPermission } = {}) {
      askPermissionHook = askPermission
    },

    /** Map a spec reply onto the ACP options the adapter offered. */
    permissionDecision,

    async createSession({ title, directory, model } = {}) {
      const session = await engineService.createSession({ directory: directory ?? process.cwd(), title, model })
      return { id: session.id }
    },

    async deleteSession(sessionID) {
      await engineService.deleteSession(sessionID)
    },

    async listSessionStatuses() {
      return Object.fromEntries([...sessionStatuses].map(([id, status]) => [id, { type: status }]))
    },

    async prompt(sessionID, { text, model } = {}) {
      try {
        await engineService.promptAndWait(sessionID, text ?? "", model)
      } catch (error) {
        // A trailing error after the reply (e.g. a background call hitting a provider limit)
        // surfaces as session.error and rejects promptAndWait — but the judge grades the turn's
        // final assistant message. The transcript may still be flushing when the error event
        // lands, so poll briefly for a text-bearing reply before failing the turn.
        const replyAppears = async () => {
          for (let attempt = 0; attempt < 15; attempt += 1) {
            const messages = await engineService.messages(sessionID, false).catch(() => [])
            const lastAssistant = [...(messages ?? [])].reverse().find((message) => message?.info?.role === "assistant")
            if ((lastAssistant?.parts ?? []).some((part) => part.type === "text" && part.text?.trim())) return true
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
          return false
        }
        if (!(await replyAppears())) throw error
      }
    },

    async abort(sessionID) {
      engineService.abort(sessionID)
    },

    async listMessages(sessionID) {
      const messages = await engineService.messages(sessionID, false)
      return normalizeAcpMessages(messages, { busy: statusOf(sessionID) === "busy" })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    // ACP asks no questions; permissions are surfaced through onInteraction instead of a
    // polled list, and replies land on the interaction queue the park path already awaits.
    listQuestions: async () => [],
    replyQuestion: async () => {},
    listPermissions: async () => [],
    replyPermission: async () => {}
  }
}

/** spec reply → ACP optionId; a reply with no matching option cancels. */
export function permissionDecision({ reply }, options = []) {
  const wanted = reply === "once" ? "allow_once" : reply === "always" ? "allow_always" : "reject"
  const option = options.find((candidate) => candidate?.kind === wanted)
  return option?.optionId ? { optionId: option.optionId } : null
}
