// bridge/test/helpers/fake-engine.js
import { EventEmitter } from "node:events"

export function createFakeEngine(overrides = {}) {
  const emitter = new EventEmitter()
  const sessions = new Map()
  const messages = new Map()
  const statuses = new Map()
  let counter = 0
  let promptHandler = async () => {}
  const engine = {
    id: "fake",
    label: "Fake",
    capabilities: { questions: false, permissions: false, abort: true },
    initialize: async () => {},
    dispose: async () => {},
    async createSession({ title } = {}) {
      const id = `ses_${++counter}`
      sessions.set(id, { title })
      messages.set(id, [])
      statuses.set(id, { type: "idle" })
      return { id }
    },
    async deleteSession(id) { sessions.delete(id); statuses.delete(id); messages.delete(id) },
    async listSessionStatuses() { return Object.fromEntries(statuses) },
    async prompt(id) { statuses.set(id, { type: "busy" }); await promptHandler(id); statuses.set(id, { type: "idle" }) },
    async abort(id) { statuses.set(id, { type: "idle" }) },
    async listMessages(id) { return messages.get(id) ?? [] },
    subscribe(listener) { emitter.on("event", listener); return () => emitter.off("event", listener) },
    emit(event) { emitter.emit("event", event) },
    listQuestions: async () => [],
    replyQuestion: async () => {},
    listPermissions: async () => [],
    replyPermission: async () => {},
    setMessages(id, list) { messages.set(id, list) },
    setPromptHandler(handler) { promptHandler = handler },
    ...overrides
  }
  return engine
}
