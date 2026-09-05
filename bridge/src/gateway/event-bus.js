// bridge/src/gateway/event-bus.js
const DEFAULT_HEARTBEAT_MS = 15_000

export function createEventBus({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  const connections = new Set()

  function emit(event) {
    for (const write of [...connections]) {
      try {
        write(event)
      } catch {
        // a dead connection is cleaned up by its own close handler
      }
    }
  }

  function subscribe(listener) {
    const forward = (event) => listener(event)
    connections.add(forward)
    return () => connections.delete(forward)
  }

  function handle(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })
    const write = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
    write({ type: "server.connected", properties: {} })
    // SSE connections register through the same subscribe() the tests observe, so there is a
    // single listener mechanism on the bus.
    const unsubscribe = subscribe(write)
    const timer = setIntervalImpl(() => write({ type: "server.heartbeat", properties: {} }), heartbeatMs)
    request.on("close", () => {
      clearIntervalImpl(timer)
      unsubscribe()
    })
  }

  return { emit, subscribe, handle }
}
