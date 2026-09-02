#!/usr/bin/env node
// bridge/src/gateway/main.js
import { realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseGatewayOptions, gatewayUsage } from "./options.js"
import { createEngine } from "./engines/engine-adapter.js"
import { createEventBus } from "./event-bus.js"
import { createSessionRegistry } from "./session-registry.js"
import { createInteractionQueue } from "./interaction-queue.js"
import { createGatewayServer } from "./gateway-server.js"

export function buildGateway(options) {
  const engine = options.engineInstance ?? createEngine(options.engine, options.engineOptions ?? {})
  const eventBus = createEventBus()
  const registry = createSessionRegistry()
  const interactionQueue = createInteractionQueue()
  const { server, askQuestion, askPermission } = createGatewayServer({
    engine, eventBus, registry, interactionQueue, defaultModel: options.defaultModel
  })
  // Engines that surface pending interactions push them through these two hooks.
  engine.onInteraction?.({
    askQuestion: (record) => askQuestion(record),
    askPermission: (record) => askPermission(record)
  })
  // Engine-emitted spec events (session.status/idle/error, message.part.updated, question/permission
  // asked) ride the SSE bus next to the bus's own server.connected/heartbeat frames: /event
  // forwards the engine's normalized events.
  engine.subscribe((event) => eventBus.emit(event))
  return { server, engine, eventBus, registry, interactionQueue }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGatewayOptions(argv)
  if (options.help) {
    process.stdout.write(`${gatewayUsage()}\n`)
    return
  }
  const gateway = buildGateway(options)
  // A busy port (EADDRINUSE) would otherwise crash with a raw stack; exit 1 with one clean line.
  gateway.server.once("error", (error) => {
    process.stderr.write(`gateway failed to start on ${options.host}:${options.port}: ${error.message}\n`)
    process.exit(1)
  })
  await gateway.engine.initialize()
  await new Promise((resolve) => gateway.server.listen(options.port, options.host, resolve))
  process.stderr.write(`gateway listening on http://${options.host}:${options.port} engine=${options.engine}\n`)
  const shutdown = async () => {
    gateway.server.close()
    await gateway.engine.dispose().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

// npm installs bins as symlinks to this file: import.meta.url resolves to the realpath
// while process.argv[1] keeps the symlink path, so the guard must compare realpaths.
export function isDirectExecution(argv1, modulePath) {
  if (!argv1) return false
  try {
    return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(modulePath)).href
  } catch {
    return false
  }
}

if (isDirectExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}
