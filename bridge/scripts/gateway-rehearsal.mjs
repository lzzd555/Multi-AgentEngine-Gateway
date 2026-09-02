#!/usr/bin/env node
// bridge/scripts/gateway-rehearsal.mjs
// End-to-end rehearsal against a RUNNING gateway: health → session → blocking prompt → SSE
// events → final-message completion rule → permission endpoint → delete. Prints a ✓/✗
// checklist and exits 0 (all green) / 1 (any red). Dev tool — NOT staged into solution.zip.
//
// Usage: node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217 --query "..."
const args = process.argv.slice(2)
const read = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index !== -1 ? args[index + 1] : fallback
}
const base = read("--url", "http://localhost:6217")
const query = read("--query", "请输出 hello world 并结束，不要执行任何其他操作")

const results = []
const check = (name, ok, detail = "") => results.push({ name, ok, detail })

// Minimal fetch-based SSE reader standing in for EventSource (no global EventSource on this Node):
// reads the /event stream, splits frames on "\n\n" and pushes each "data: " payload into events.
// Aborting the signal tears the stream down without leaking the connection.
async function readEvents(url, events, signal) {
  const response = await fetch(url, { signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf("\n\n")
      while (separator !== -1) {
        const frame = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue
          try {
            events.push(JSON.parse(line.slice("data: ".length)))
          } catch {
            // a malformed frame is dropped
          }
        }
        separator = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function waitForEvent(events, type, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!events.some((event) => event.type === type) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function main() {
  const events = []
  const controller = new AbortController()
  const reading = readEvents(`${base}/event`, events, controller.signal)
  reading.catch(() => {}) // an unreachable gateway leaves events empty; the checks report it

  let startedAt = Date.now()
  let sessionID
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null)
    check("health", Boolean(health?.ok))

    const session = await fetch(`${base}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "rehearsal" })
    }).then((r) => r.json()).catch(() => null)
    check("create session", Boolean(session?.id))
    sessionID = session?.id

    let promptResponse = null
    if (sessionID) {
      await waitForEvent(events, "server.connected") // SSE must be live before the busy event fires
      startedAt = Date.now()
      promptResponse = await fetch(`${base}/session/${sessionID}/prompt_async`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: query }] })
      }).catch(() => null)
    }
    check("prompt returns 204", promptResponse?.status === 204, promptResponse ? `http ${promptResponse.status}` : "no response")

    const messages = sessionID
      ? await fetch(`${base}/session/${sessionID}/message`).then((r) => r.json()).catch(() => [])
      : []
    const last = messages.at(-1)
    check("final message is assistant", last?.role === "assistant")
    check("finish=stop", last?.info?.finish === "stop")
    check("step-finish present", Boolean(last?.parts?.some((part) => part.type === "step-finish")))

    await waitForEvent(events, "session.idle")
    const types = events.map((event) => event.type)
    check("server.connected", types.includes("server.connected"))
    check("session.status", types.includes("session.status"))
    check("session.idle", types.includes("session.idle"))

    const permissions = await fetch(`${base}/permission`).then((r) => r.json()).catch(() => null)
    check("permission endpoint", Array.isArray(permissions))
  } finally {
    if (sessionID) await fetch(`${base}/session/${sessionID}`, { method: "DELETE" }).catch(() => {})
    controller.abort()
    await reading.catch(() => {})
  }

  for (const result of results) {
    console.log(`${result.ok ? "✓" : "✗"} ${result.name}${result.detail ? ` (${result.detail})` : ""}`)
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed in ${elapsed}s`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
