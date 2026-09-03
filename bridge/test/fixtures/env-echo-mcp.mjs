#!/usr/bin/env node
// bridge/test/fixtures/env-echo-mcp.mjs
// 最小零依赖 MCP stdio server（newline-delimited JSON-RPC 2.0 over stdin/stdout），用于离线验证
// 网关 mcp 供给链路：env 展开后注入子进程的值能否经工具调用原样回传。
// 约束：响应只能写 stdout（单行 JSON + "\n"），任何日志走 stderr——stdio 协议里 stdout 是信道。
import readline from "node:readline"

const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

const ECHO_ENV_TOOL = {
  name: "echo_env",
  description: "Return the value of the given environment variable",
  inputSchema: { type: "object", properties: { var: { type: "string" } }, required: ["var"] }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function handleLine(line) {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return // 坏行直接丢弃：stdio 传输层不为其产生响应
  }
  switch (message.method) {
    case "initialize":
      // 引擎协商的协议版本各异：回显客户端值（若有），否则用默认
      reply(message.id, {
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "env-echo", version: "0.0.1" }
      })
      return
    case "notifications/initialized":
      return // 通知（无 id）不产生响应
    case "tools/list":
      reply(message.id, { tools: [ECHO_ENV_TOOL] })
      return
    case "tools/call": {
      const name = message.params?.arguments?.var
      reply(message.id, { content: [{ type: "text", text: process.env[name] ?? `<unset:${name}>` }] })
      return
    }
    default:
      // 未知方法：请求（有 id）回 -32601；通知静默
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
      }
  }
}

// node --test 会把 test/ 目录下的所有文件当测试执行（helpers/ 里的既有文件靠"导入无副作用"躲过）。
// 本 fixture 顶层就要读 stdin，被 runner 拾起时（runner 会设 NODE_TEST_CONTEXT）必须空跑退出，
// 只在被真实 spawn 为 MCP 子进程时启动 stdio 服务器。
if (!process.env.NODE_TEST_CONTEXT) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on("close", () => process.exit(0))
  rl.on("line", handleLine)
}
