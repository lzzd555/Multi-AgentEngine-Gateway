// bridge/src/gateway/options.js
function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

function parsePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }
  return port
}

export function parseGatewayOptions(args, environment = process.env) {
  const options = {
    engine: environment.AGENT_ENGINE ?? environment.ENGINE ?? environment.HARNESS_REMOTE_BACKEND ?? "opencode",
    host: environment.GATEWAY_HOST ?? "localhost",
    port: parsePort(environment.GATEWAY_PORT ?? "6217"),
    defaultModel: environment.GATEWAY_DEFAULT_MODEL ?? "zai/glm-5.2",
    configPath: undefined,
    defaultModelExplicit: Boolean(environment.GATEWAY_DEFAULT_MODEL)
  }
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--engine":
        options.engine = requireValue(args, index, "--engine")
        index += 1
        break
      case "--host":
        options.host = requireValue(args, index, "--host")
        index += 1
        break
      case "--port":
        options.port = parsePort(requireValue(args, index, "--port"))
        index += 1
        break
      case "--model":
        options.defaultModel = requireValue(args, index, "--model")
        options.defaultModelExplicit = true
        index += 1
        break
      case "--config":
        options.configPath = requireValue(args, index, "--config")
        index += 1
        break
      case "--help":
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${args[index]}`)
    }
  }
  return options
}

export function gatewayUsage() {
  return [
    "Usage: harness-gateway [options]",
    "",
    "Options:",
    "  --engine <name>   Agent engine: opencode, omp, pi (env AGENT_ENGINE; default opencode)",
    "  --host <host>     Bind host (default localhost)",
    "  --port <port>     Bind port (default 6217)",
    "  --model <id>      Default model wire name (default zai/glm-5.2)",
    "  --config <path>   Unified gateway config file (default ./gateway.config.json; env GATEWAY_CONFIG)"
  ].join("\n")
}
