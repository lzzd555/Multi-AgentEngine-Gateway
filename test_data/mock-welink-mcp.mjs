#!/usr/bin/env node
// 模拟 WeLink welink-msg MCP server（离线测试用）
// 仿照华为 welink-msg MCP 的形态：stdio JSON-RPC，暴露发消息工具。
// 每次调用把消息完整记录到 outbox 文件，供测试核验"是否有实际信息"。
import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import readline from "node:readline"

// macOS 的 os.tmpdir() 是 /var/folders/.../T 而非 /tmp，为可预测性固定用 /tmp（Windows 回落 os.tmpdir()）。
const OUTBOX_DIR = process.env.WELINK_OUTBOX_DIR ?? (process.platform === "win32" ? path.join(os.tmpdir(), "welink-mock-outbox") : "/tmp/welink-mock-outbox")
const OUTBOX_FILE = path.join(OUTBOX_DIR, "messages.json")
mkdirSync(OUTBOX_DIR, { recursive: true })
try { writeFileSync(OUTBOX_FILE, "[]") } catch {}
process.stderr.write(`[welink-mock] outbox: ${OUTBOX_FILE}\n`)

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n") }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }) }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }) }

function record(entry) {
  let all = []
  try { all = JSON.parse(readFileSync(OUTBOX_FILE, "utf8")) } catch { all = [] }
  all.push(entry)
  writeFileSync(OUTBOX_FILE, JSON.stringify(all, null, 2))
}

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "welink-msg", version: "1.0.8-mock" }
    })
    return
  }
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return
  if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "send_message",
          description: "给指定 WeLink 工号（员工账号 accountId/account/工号）发送一条文本消息。content/message 为消息正文。",
          inputSchema: {
            type: "object",
            properties: {
              account: { type: "string", description: "接收方工号，如 y00942037（accountId/account/to 均映射到此参数）" },
              content: { type: "string", description: "消息正文文本（message/text 均映射到此参数）" }
            },
            required: ["account", "content"]
          }
        }
      ]
    })
    return
  }
  if (msg.method === "tools/call") {
    const tool = msg.params?.name
    if (tool !== "send_message") return replyError(msg.id, -32602, `Unknown tool: ${tool}`)
    const args = msg.params?.arguments ?? {}
    const account = args.account ?? args.accountId ?? args.to ?? args.userId ?? ""
    const content = args.content ?? args.message ?? args.text ?? ""
    if (!account || !content) {
      reply(msg.id, { content: [{ type: "text", text: `ERROR: account and content are required (got account=${JSON.stringify(account)}, content=${JSON.stringify(content)})` }], isError: true })
      return
    }
    const entry = { at: new Date().toISOString(), account, content, token: process.env.WELINK_TOKEN ? "present" : "absent" }
    record(entry)
    process.stderr.write(`[welink-mock] 消息已投递: ${account} ← ${content}\n`)
    reply(msg.id, { content: [{ type: "text", text: `OK: message delivered to ${account}` }] })
    return
  }
  if (msg.id !== undefined) replyError(msg.id, -32601, `Method not found: ${msg.method}`)
})
rl.on("close", () => process.exit(0))
