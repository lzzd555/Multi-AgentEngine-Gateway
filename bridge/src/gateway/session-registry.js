// bridge/src/gateway/session-registry.js
export function createSessionRegistry({ now = () => new Date().toISOString() } = {}) {
  const sessions = new Map()
  return {
    register({ id, title }) {
      const record = { id, title: title ?? id, created_at: now(), status: "idle" }
      sessions.set(id, record)
      return record
    },
    get(id) {
      return sessions.get(id)
    },
    has(id) {
      return sessions.has(id)
    },
    setStatus(id, status) {
      const record = sessions.get(id)
      if (record) record.status = status
    },
    statuses() {
      return Object.fromEntries([...sessions.values()].map((record) => [record.id, { type: record.status }]))
    },
    remove(id) {
      sessions.delete(id)
    }
  }
}
