# 多引擎可替换 Agent 网关改造设计

- 日期：2026-09-01
- 状态：已评审通过
- 需求来源：`多agent引擎可替换架构实现-任务书.md`、`Agent 网关接口规范.md`（v1.1）
- 改造路径：方案 B' —— 在 `bridge/src/gateway/` 新增赛题网关，复用 bridge 作为引擎驱动库
- 引擎范围：OpenCode、OMP、PI（均需接入 GLM5.2）

## 1. 背景与目标

赛题要求构建"Agent 网关 + Agent 引擎（harness）"架构的智能体系统：

1. 精确实现《Agent 网关接口规范》定义的 HTTP API（默认端口 6217），供评测系统调用；
2. 至少接入 2 种 Agent 引擎，通过 `--engine` 启动参数（任务书另要求支持环境变量）切换，不同轮次评测分别以不同引擎启动；
3. 代码支持 Windows 沙箱运行；模型使用 GLM5.2；
4. 交付 `solution.zip`（内含 `INSTRUCTION.md` + `code/`）。

评分：客观 70%（Rollout 执行 + LLM 裁判，对每个引入引擎分别评测、每用例取最高分）；主观 30%（架构合理性 20%、创新 5%、鲁棒 5%）。

## 2. 现状分析

仓库为 harness-remote（Apache-2.0）。bridge 为 Node.js ≥20、纯 ESM、**零 npm 依赖**（原生 `node:http`），Windows 兼容处理完备（`.cmd/.bat` 经 `ComSpec` 启动、`taskkill` 杀进程树、PATHEXT 解析、`windowsHide`）。

### 2.1 可复用资产

| 资产 | 位置 | 说明 |
|---|---|---|
| HTTP 路由骨架 | `bridge/src/server.js` | 已有 `POST /session`(:382)、`GET /session/status`(:360)、`DELETE /session/{id}`(:398)、`prompt_async`(:445)、`GET .../message`(:403)、`abort`(:463)、SSE(:334) |
| 引擎注册表 | `bridge/src/harness-profiles.js` | omp/pi/claude/codex 的启动命令、能力开关、模型配置项 |
| ACP 引擎驱动 | `bridge/src/acp-client.js`、`acp-service.js` | stdio JSON-RPC：spawn/握手/看门狗/通知分发；会话/消息/状态/事件全量管理 |
| 阻塞 prompt 原语 | `acp-service.js:1205` `promptAndWait()` | busy→idle 判定，当前未被 HTTP 路由使用 |
| OpenCode 引擎驱动 | `bridge/src/opencode-host.js` | `opencode serve` 托管进程、就绪探测、事件扇出 |
| 跨引擎完成推断 | `bridge/src/task-launcher.js` | OpenCode 侧 status 轮询与完成判定逻辑可提炼 |
| 模型目录 | `bridge/src/agent-model-catalog.js` | 按 providerID/modelID 透传，无硬编码模型 |
| CLI/env 配置 | `bridge/src/config.js`、`launcher.js` | `--backend` 即 `--engine` 等价物 |
| 测试资产 | `bridge/test/`（83 个文件）、`helpers/fake-omp-acp.js` | node --test、假 ACP 引擎可做无外部依赖集成测试 |

### 2.2 与规范的差距（= 改造工作量）

1. `prompt_async` 提交即返回 204，规范要求**阻塞到本轮完成**；
2. 权限请求自动放行（`acp-client.js:311` 直接回 `allow_once`），无挂起队列与 `POST /permission/{id}/reply` 流程；`/question` 对 ACP 引擎完全缺失；
3. SSE：路径 `/global/event` 而非 `/event`；缺 `server.connected`；心跳为 10s 匿名注释 `: ping`，规范要求 15s 命名事件 `server.heartbeat`；事件名需映射（`session.updated`→`session.status`、`message.updated`→`message.part.updated`，需新增 `session.idle`、`question.asked`、`permission.asked`）；
4. 消息格式：规范要求 assistant 消息含 `tool_calls` 数组、`info.finish`（stop/tool-calls）、`step-finish` part 与独立 `role:"tool"` 消息，ACP 侧均需推导；
5. 缺 `GET /session/{id}` 单会话查询、`/session/{id}/stop` 备选路径；
6. 默认端口 4097 → 6217；网关模式应无 Basic-auth/CORS 产品默认（评测裸调 localhost）。

### 2.3 为什么不改造现有 server.js（方案 A 弃用理由）

现有路由的消费者是 harness-remote 自带 web UI：阻塞化 prompt_async、改事件名、改消息格式都会破坏 UI 兼容；产品安全默认（Basic-auth）与评测裸调冲突；daemon"运行时多引擎复用"与赛题"部署时单引擎独占"是两种生命周期。因此新建网关层，bridge 仅做一处向后兼容的受控修改（§7）。

## 3. 总体架构

```
评测系统（裁判）
    │ HTTP :6217（规范 14 个端点 + SSE /event）
    ▼
bridge/src/gateway/                      ← 新增，赛题网关
  main.js               入口：--engine/--port/--host + ENGINE 环境变量
  gateway-server.js     路由层：无鉴权、精确保现规范
  event-bus.js          SSE：server.connected / 15s server.heartbeat / 规范全部 8 类事件
  session-registry.js   会话表：id/title/created_at/status/message_count（内存态）
  interaction-queue.js  question/permission 挂起登记、超时、reply 分发
  message-normalizer.js 目标消息 schema 与共享推导助手
  engines/
    engine-adapter.js   EngineAdapter 契约 + createEngine(id) 工厂
    opencode-engine.js  驱动 ManagedOpenCodeHost（HTTP+SSE，近乎透传）
    acp-engine.js       驱动 AcpService（stdio JSON-RPC，omp/pi 通用）
    normalize-acp.js    ACP 消息/事件 → 规范格式（被 acp-engine 使用）
    normalize-opencode.js OpenCode 原生消息/事件 → 规范格式
    ▼ 复用 bridge 现有模块          ▼ bridge 受控修改
  AcpService/AcpClient/harness-profiles/
  opencode-host/config/Windows 处理   acp-client.js 可注入权限挂起处理器
```

### 3.1 Import 边界规则（日后迁新仓库的保证）

- **网关核心**（main、gateway-server、event-bus、session-registry、interaction-queue、message-normalizer、engine-adapter）：**禁止 import bridge/src 中 gateway/ 之外的任何模块**，只用 Node 内置模块；
- **仅** `engines/opencode-engine.js` 与 `engines/acp-engine.js`（及其同目录 normalize-* 助手）允许 import bridge 驱动模块；
- 引擎驱动依赖闭包（AcpService 的内部依赖：transcript-cache、journal loaders、harness-profiles、acp-client 等）维护一份显式清单 `gateway/ENGINES-DEPS.md`，迁库时按清单拷贝；
- bridge 为纯 ESM 零依赖文件集，拷贝即用。再发布时保留 Apache-2.0 LICENSE 与出处声明。

## 4. EngineAdapter 契约

```js
// engines/engine-adapter.js
createEngine(id, options) → Engine
// id ∈ "opencode" | "omp" | "pi"（"claude"|"codex" 保留为 ACP 家族扩展位）

Engine = {
  id, label,
  capabilities: { questions: bool, permissions: bool, abort: bool },

  initialize(),            // 启动引擎进程/探测就绪（ACP: spawn+握手；OpenCode: opencode serve 就绪轮询）
  dispose(),

  createSession({ title, directory }) → { id },
  getSession(id) → { id, title, created_at, message_count },
  deleteSession(id),
  listSessionStatuses() → { [sessionId]: { type: "idle"|"busy" } },

  prompt(sessionId, { text, model }) → Promise<void>,
  // ★阻塞到本轮完成（含全部工具调用）；abort 或引擎错误时 reject

  abort(sessionId),
  listMessages(sessionId) → NormalizedMessage[],

  subscribe(listener) → unsubscribe,
  // ★只发引擎侧 6 类事件：session.status / session.idle / session.error /
  //   message.part.updated / question.asked / permission.asked
  //   （server.connected / server.heartbeat 由 event-bus 自行产生）

  onPermission(cb) / resolvePermission(id, { reply, message }),
  onQuestion(cb)    / resolveQuestion(id, answers),
}
```

- 引擎选择：`--engine <id>`（优先）或环境变量 `ENGINE`（并兼容既有 `HARNESS_REMOTE_BACKEND`）；`--port` 默认 6217，`--host` 默认 `localhost`；
- 新增引擎成本：ACP 家族新引擎 = harness-profiles 已有 profile + 工厂注册一行；网关核心零改动。

## 5. 端点合规映射

| 规范端点 | 实现要点 |
|---|---|
| `POST /session` | registry 登记 + `engine.createSession`；`directory` 查询参数传引擎作工作目录（会话隔离）；响应含 id/title/created_at/status=idle |
| `GET /session/{id}` | registry 视图 + message_count（新增路由） |
| `DELETE /session/{id}` | `engine.deleteSession` + registry 移除，响应 `{ok:true}` |
| `GET /session/status` | registry 状态表，`{sessionId:{type}}` |
| `POST /session/{id}/prompt_async` | registry→busy（发 session.status 事件）→ `engine.prompt()` 阻塞 → idle（发 session.status + session.idle）→ **204**；期间 part 级事件持续经 SSE 推送 |
| `GET /session/{id}/message` | `engine.listMessages()` → 规范格式数组 |
| `POST /session/{id}/abort`、`/stop` | `engine.abort`；`/stop` 为规范备选路径别名 |
| `GET /question`、`POST /question/{id}/reply` | interaction-queue；`capabilities.questions=false` 的引擎恒返回 `[]`，reply 对不存在 id 返回 404 |
| `GET /permission`、`POST /permission/{id}/reply` | interaction-queue；reply ∈ once/always/reject |
| `GET /event` | 连接即发 `server.connected`；每 15s 发 `server.heartbeat`（命名事件，非注释心跳）；转发引擎规范化事件 |
| 错误 | 统一 `{code, message}`：400 VALIDATION_ERROR / 404 NOT_FOUND / 500 INTERNAL_ERROR / 502 BAD_GATEWAY（引擎进程失败或不可达）/ 503 SERVICE_UNAVAILABLE |

**完成判定硬约束**：评测以"最后一条 assistant 消息 `info.finish=stop` 且 parts 含 `step-finish`"判定本轮结束。normalizer 必须在每轮结束可靠产出两者；prompt() resolve 前 message 列表必须已包含该终态消息（先落消息、后置 idle、再返回 204 的顺序保证）。

## 6. 消息规范化规则

目标 schema（规范 §4.2）：`{ id, role: user|assistant|tool, content, tool_calls?[], tool_call_id?, tool_name?, created_at, info?{role,finish}, parts?[{type:text|tool|step-finish, ...}] }`。

OpenCode 原生消息即该格式蓝本，`normalize-opencode.js` 仅做字段校验与透传（含原生 step-finish）。

`normalize-acp.js` 推导规则：

1. **user 消息**：ACP user message → `{role:"user", content}`；
2. **parts 映射**：text part → `{type:"text", content}`；tool part → `{type:"tool", tool, state:{status, title}}`（status 映射 pending/running→running、completed→completed、error/incomplete→error 标注）；reasoning part 不映射进规范消息（规范未定义 reasoning 类型，裁判仅需 text/tool/step-finish），仅留日志；
3. **step-finish 插入**：每个 LLM step 边界（一段 text part 完成，或一批 tool part 全部终结）插入 `{type:"step-finish"}`；
4. **info.finish 推导**：step 以 tool 批次结尾且后续还有 step → `tool-calls`；本轮最后一个 step 产出文本且无运行中工具 → `stop`；会话被 abort → 最后 step 标 `stop` 并附 content 说明；
5. **tool_calls 聚合**：从本 step 的 tool parts 生成 `[{id: callID, name: tool, arguments: state.input}]`；
6. **独立 tool 消息**：tool part 终结时合成 `{role:"tool", tool_call_id, tool_name, content: state.output 摘要}`；
7. `content`：assistant 消息取全部 text parts 拼接。

事件映射（acp-engine 内完成，diff 快照产出 part 级增量）：`session.updated`→`session.status`；turn 结束→`session.idle`；错误→`session.error`；part 变化→`message.part.updated`。

## 7. bridge 受控修改（仅 1 处行为性修改）

`bridge/src/acp-client.js` `#respondPermission`（现 :311）：构造 `AcpClient` 时可注入 `permissionHandler(agentRequest) → Promise<replyOutcome>`。

- 注入时：`session/request_permission` 转交 handler 挂起（网关侧入 interaction-queue、发 `permission.asked`），由 `POST /permission/{id}/reply` resolve；
- 未注入时：维持现状（permissionMode=allow → `allow_once`，否则取消）——**产品路径零回归**；
- 其他 agent-initiated 请求维持 `-32601`（ACP 无 question 语义，不虚构）。

其余 bridge 文件原则上不动；如 harness-profiles 需要补充网关字段（如默认模型提示），保持可选字段向后兼容。

## 8. GLM5.2 接入

- Provider 走 OpenAI 兼容协议：官方 `https://api.z.ai/api/paas/v4` 或自定义 baseURL（`ZAI_BASE_URL`），key 用 `ZAI_API_KEY`；三引擎各附配置模板（OpenCode：opencode.json 的 provider 配置；OMP、PI：各自 provider 配置），模板随 solution.zip 交付、由 INSTRUCTION.md 指引填充；
- 网关默认模型环境变量 `GATEWAY_DEFAULT_MODEL`（默认 `zai/glm-5.2`）；请求携带 `model.providerID/modelID` 时原样透传引擎；
- 沙箱无外网场景由自定义 baseURL 覆盖。

## 9. Windows 与交付

- 进程管理继承 bridge 现有 Windows 处理（ComSpec/taskkill/PATHEXT/windowsHide），无新增 Unix-only 依赖；
- M3 在 Windows 实机（或 CI windows runner）跑冒烟：三引擎各启动、创建会话、发一条 prompt、收到规范事件与终态消息、abort、权限挂起回复；
- 交付物：
  - `INSTRUCTION.md`：环境准备（Node≥20、`npm i -g opencode`、omp、pi 安装、GLM 配置）、执行方式（规范形式的 `gateway --engine <id> --port 6217`：solution 内附 `gateway.cmd`/`gateway` 包装脚本转发到 `node code/bridge/src/gateway/main.js`，亦支持 `node bridge/src/gateway/main.js` 直启与环境变量等价形式）、完成判定（health/就绪日志）、结果交付件说明；
  - 打包脚本 `bridge/scripts/package-solution.mjs`：收集 gateway/ + ENGINES-DEPS.md 驱动闭包 + 配置模板 + INSTRUCTION.md → `solution.zip`（solution/{INSTRUCTION.md, code/}）。

## 10. 测试策略

1. **单元**：event-bus（连接事件、15s 心跳、事件名）、session-registry 状态机、interaction-queue（挂起/回复/超时）、normalize-acp 推导（finish/step-finish/tool_calls 用构造的 ACP 消息序列固化边界情况）；
2. **集成**：复用 `bridge/test/helpers/fake-omp-acp.js` 假引擎驱动 acp-engine 全链路（含权限挂起闭环）；OpenCode 适配器以注入式 HTTP stub 测试；
3. **规范符合性**：`gateway/spec-conformance.test.js` 逐条断言规范附录 B checklist（路径、状态码、事件名、错误体、完成判定标记），作为评委可读的合规证据。

## 11. 里程碑计划

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| M1 网关骨架 + OpenCode 引擎 | gateway 六件套 + opencode-engine + normalize-opencode；端口/阻塞/SSE/错误体合规 | 附录 B checklist 对 OpenCode 全绿；端到端跑通样例任务（如 office_002） |
| M2 ACP 引擎 + 交互改造 | acp-engine + normalize-acp；acp-client 权限注入；omp、pi 注册 | omp/pi 各过 checklist；权限挂起→reply 闭环；bridge 既有测试全绿 |
| M3 GLM5.2 + Windows + 交付 | 三引擎 provider 模板、Windows 冒烟、INSTRUCTION.md、打包脚本 | solution.zip 解压即用 |
| M4 三引擎全链路演练 | 每引擎以评测样例跑完整轮次（SSE/完成判定/权限回复） | 自测报告 + spec-conformance 全绿 |

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| PI 的 Windows 适配器成熟度未验证 | M1 末先行冒烟；不可用则以 claude/codex ACP 适配器顶替（ACP 家族现成） |
| finish/step-finish 推导边界情况（多 step、abort、引擎错误） | 规范符合性测试以假引擎回放序列固化；推导规则在 normalize-acp 注释中显式陈述 |
| 评测沙箱网络受限 | baseURL/key 全环境变量化 |
| 长轮次阻塞请求超时 | prompt 阻塞期间 SSE 持续有心跳与 part 事件；评测判定不依赖该请求的及时返回 |
| bridge 回归 | 唯一行为修改带"未注入即旧行为"守卫；bridge 既有 83 个测试文件必须保持全绿 |

## 13. 后续迁库指引

1. 拷贝 `bridge/src/gateway/` 全目录；
2. 按 `gateway/ENGINES-DEPS.md` 清单拷贝驱动闭包（相对 import 结构保持不变）；
3. 拷贝/合并 `bridge/package.json` 要点（`"type":"module"`、engines ≥20）；
4. 保留 Apache-2.0 LICENSE 与 harness-remote 出处声明。
