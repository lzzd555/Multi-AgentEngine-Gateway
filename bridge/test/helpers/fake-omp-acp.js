import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * An `omp acp` stand-in that follows oh-my-pi 18.x rather than Harness Remote's reading of it.
 *
 * Every behaviour below is taken from a specific place in the OMP source, because a fake that
 * merely reproduces what the bridge already expects can only ever confirm the bridge's own
 * assumptions:
 *
 * - `AcpAgent.initialize` advertises `sessionCapabilities.resume`, which is what makes
 *   `session/resume` usable at all.
 * - `AcpAgent.loadSession` calls `#replaySessionHistory`; `AcpAgent.resumeSession` does not. Both
 *   open the same stored Session (`#openStoredSession`) and both answer with `configOptions`.
 * - `#replaySessionHistory` mints `crypto.randomUUID()` per replayed message, and flattens tool
 *   results and every non-dialogue role into `user_message_chunk`s.
 * - The live path never emits `user_message_chunk` at all: `acp-event-mapper.ts` only produces
 *   `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` and `plan`.
 * - `record.liveMessageId ??= crypto.randomUUID()` gives one id per live assistant message, unrelated
 *   to anything on disk.
 * - `prompt()` resolves only after `#emitEndOfTurnUpdates` and `#waitForAcpPromptIdle`, so the last
 *   chunk is always delivered before the response.
 * - `SessionManager#recordEntry` appends each entry to the JSONL as it is created; an assistant
 *   message is written once, when it ends.
 * - `#emitBootstrapUpdates` advertises the slash commands after every new/load/resume, and
 *   `/rename` is one of them: it calls `setSessionName(title, "user")`, which rewrites the title
 *   slot, appends a `title_change` entry and marks the name user-set.
 */
export class FakeOmpAcp extends EventEmitter {
  constructor({ sessionRoot, cwd = "/repo", models = ["anthropic/claude-sonnet-4", "openai/gpt-5.6"] } = {}) {
    super()
    this.sessionRoot = sessionRoot
    this.cwd = cwd
    this.models = models
    this.requests = []
    this.notifications = []
    this.sessions = new Map()
    this.openSessions = new Set()
    this.processID = 4242
    this.promptCapabilities = { image: true, embeddedContext: true }
    this.sessionCapabilities = { list: {}, fork: {}, resume: {}, close: {} }
    this.agentInfo = { name: "oh-my-pi", title: "Oh My Pi", version: "18.0.7" }
    this.availableCommands = [
      { name: "rename", description: "Rename the current session", input: { hint: "<title>" } },
      { name: "model", description: "Show current model selection" }
    ]
    this.turns = []
  }

  /** Register a stored Session whose journal already exists, as if OMP had written it elsewhere. */
  async seedSession(sessionId, { entries = [], title = "Stored session", version = 3, withTitleSlot = true } = {}) {
    // OMP writes the fixed-width slot even when the Session has no name yet.
    const file = path.join(this.sessionRoot, `2026-08-26_${sessionId}.jsonl`)
    await mkdir(this.sessionRoot, { recursive: true })
    const lines = []
    if (withTitleSlot) {
      const slot = { type: "title", v: 1, title: title ?? "", updatedAt: "2026-08-26T10:00:00.000Z", pad: "" }
      const encoded = JSON.stringify(slot)
      lines.push(`${encoded}${" ".repeat(Math.max(0, 256 - encoded.length - 1))}`)
    }
    lines.push(JSON.stringify({
      type: "session",
      ...(version >= 2 ? { version } : {}),
      id: sessionId,
      ...(title ? { title } : {}),
      timestamp: "2026-08-26T10:00:00.000Z",
      cwd: this.cwd
    }))
    for (const entry of entries) lines.push(JSON.stringify(entry))
    await writeFile(file, `${lines.join("\n")}\n`)
    this.sessions.set(sessionId, { file, title, entries: [...entries], model: this.models[0], thinking: "off" })
    return file
  }

  #record(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`ACP session not found: ${sessionId}`)
    return session
  }

  async #append(sessionId, entry) {
    const session = this.#record(sessionId)
    const parentId = session.entries.at(-1)?.id ?? null
    const stored = { ...entry, id: entry.id ?? randomUUID().slice(-8), parentId }
    session.entries.push(stored)
    await appendFile(session.file, `${JSON.stringify(stored)}\n`)
    return stored
  }

  #configOptions(sessionId) {
    const session = this.#record(sessionId)
    return [
      {
        id: "model",
        name: "Model",
        currentValue: session.model,
        options: this.models.map((value) => ({ value, name: value }))
      },
      {
        id: "thinking",
        name: "Thinking",
        currentValue: session.thinking,
        options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }]
      }
    ]
  }

  /** `#emitBootstrapUpdates`: the command catalog every open advertises. */
  #bootstrap(sessionId) {
    this.#notify(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: this.availableCommands
    })
  }

  #notify(sessionId, update) {
    const notification = { method: "session/update", params: { sessionId, update } }
    this.notifications.push(notification)
    this.emit("notification", notification)
  }

  async start() {}

  async listSessions() {
    return [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      cwd: this.cwd,
      title: session.title,
      updatedAt: "2026-08-26T10:00:00.000Z",
      _meta: { messageCount: session.entries.length }
    }))
  }

  notify(method, params) {
    this.requests.push([method, params])
    if (method === "session/cancel") {
      const session = this.sessions.get(params.sessionId)
      if (session) session.cancelled = true
    }
  }

  calls(method) {
    return this.requests.filter(([name]) => name === method)
  }

  async request(method, params) {
    this.requests.push([method, params])
    switch (method) {
      case "session/new": {
        const sessionId = `omp-${this.sessions.size + 1}`
        await this.seedSession(sessionId, { title: undefined })
        this.openSessions.add(sessionId)
        this.#bootstrap(sessionId)
        return { sessionId, configOptions: this.#configOptions(sessionId) }
      }
      case "session/load": {
        this.#record(params.sessionId)
        this.openSessions.add(params.sessionId)
        // `#replaySessionHistory`: one fresh uuid per message, tool results flattened into
        // `user_message_chunk`s, and no relationship to the ids the journal stores.
        for (const entry of this.#record(params.sessionId).entries) {
          if (entry.type !== "message") continue
          const messageId = randomUUID()
          const message = entry.message
          if (message.role === "assistant") {
            for (const block of Array.isArray(message.content) ? message.content : []) {
              if (block.type === "text") {
                this.#notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text }, messageId })
              }
              if (block.type === "thinking") {
                this.#notify(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking }, messageId })
              }
            }
            continue
          }
          const text = typeof message.content === "string"
            ? message.content
            : (Array.isArray(message.content) ? message.content : [])
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
          if (text) this.#notify(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId })
        }
        this.#bootstrap(params.sessionId)
        return { configOptions: this.#configOptions(params.sessionId) }
      }
      case "session/resume": {
        this.#record(params.sessionId)
        this.openSessions.add(params.sessionId)
        this.#bootstrap(params.sessionId)
        return { configOptions: this.#configOptions(params.sessionId) }
      }
      case "session/set_config_option": {
        const session = this.#record(params.sessionId)
        if (params.configId === "model") {
          session.model = params.value
          await this.#append(params.sessionId, {
            type: "model_change",
            timestamp: new Date().toISOString(),
            model: params.value
          })
        }
        if (params.configId === "thinking") session.thinking = params.value
        return { configOptions: this.#configOptions(params.sessionId) }
      }
      case "session/prompt":
        return await this.#prompt(params)
      default:
        return {}
    }
  }

  /**
   * The scripted answer for the next `session/prompt` on any Session.
   *
   * `reasoning`, `tool` and `text` map onto the three notification kinds the live mapper produces;
   * `text` accepts several chunks because a real answer streams that way and the last one has to be
   * the one the client ends up showing.
   */
  queueTurn(turn) {
    this.turns.push(turn)
  }

  async #prompt(params) {
    const sessionId = params.sessionId
    const session = this.#record(sessionId)
    session.cancelled = false
    const promptText = (params.prompt ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
    // A slash command is consumed before the model sees it: `/rename` renames the Session, answers
    // with a confirmation line, and journals a `title_change` entry rather than a conversation turn.
    if (promptText.startsWith("/rename ")) {
      const title = promptText.slice("/rename ".length).trim()
      if (title) {
        session.title = title
        await this.#append(sessionId, { type: "title_change", timestamp: new Date().toISOString(), title, source: "user" })
      }
      this.#notify(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Session renamed to ${title}.` },
        messageId: randomUUID()
      })
      return { stopReason: "end_turn" }
    }
    await this.#append(sessionId, {
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: promptText, timestamp: Date.now() }
    })

    const turn = this.turns.shift() ?? { text: ["Answer"] }
    const provider = session.model.split("/")[0]
    const model = session.model.split("/")[1]
    const assistantEntry = (content, extra = {}) => this.#append(sessionId, {
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", provider, model, content, timestamp: Date.now(), ...extra }
    })

    // `#getLiveMessageId` mints one id per live assistant message and
    // `#clearLiveAssistantMessageAfterEvent` drops it when that message ends, so a turn that calls a
    // tool streams under two ids - and journals two assistant entries, the tool-calling one first.
    const thinkingId = randomUUID()
    const reasoningContent = []
    for (const thought of turn.reasoning ?? []) {
      this.#notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought }, messageId: thinkingId })
      reasoningContent.push({ type: "thinking", thinking: thought })
    }
    const tools = turn.tools ?? []
    for (const tool of tools) {
      this.#notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: tool.id,
        title: tool.name,
        status: "in_progress",
        rawInput: tool.input,
        _meta: { toolName: tool.name }
      })
    }
    if (session.cancelled) {
      // `#resolveStopReason` reports `cancelled`, and the aborted assistant message keeps
      // `USER_INTERRUPT_LABEL` on `errorMessage` - which OMP's own renderers suppress.
      await assistantEntry(reasoningContent, { stopReason: "aborted", errorMessage: "Interrupted by user" })
      return { stopReason: "cancelled" }
    }
    if (reasoningContent.length || tools.length) {
      await assistantEntry(
        [...reasoningContent, ...tools.map((tool) => ({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.input ?? {} }))],
        { stopReason: tools.length ? "toolUse" : "endTurn" }
      )
    }
    for (const tool of tools) {
      this.#notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: tool.id,
        status: "completed",
        rawOutput: tool.output ?? "done"
      })
      await this.#append(sessionId, {
        type: "message",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: tool.id,
          toolName: tool.name,
          content: [{ type: "text", text: tool.output ?? "done" }],
          isError: false,
          timestamp: Date.now()
        }
      })
    }

    const answerId = randomUUID()
    for (const chunk of turn.text ?? []) {
      this.#notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk }, messageId: answerId })
    }
    if ((turn.text ?? []).length) {
      await assistantEntry([{ type: "text", text: (turn.text ?? []).join("") }], { stopReason: "endTurn" })
    }
    return { stopReason: "end_turn" }
  }
}
