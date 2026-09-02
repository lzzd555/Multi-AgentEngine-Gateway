# Agent 网关接口规范



本文档定义了比赛评测所需的 Agent 网关 HTTP API 接口规范。参赛者需要实现该接口，以支持评测系统调用。



## 目录



- [1. 概述](#1-概述)

- [2. 基础信息](#2-基础信息)

- [3. 会话管理接口](#3-会话管理接口)

- [4. 消息交互接口](#4-消息交互接口)

- [5. 交互处理接口](#5-交互处理接口)

- [6. SSE 事件流接口](#6-sse-事件流接口)

- [7. 错误处理](#7-错误处理)

- [8. 完整交互流程](#8-完整交互流程)



---



## 1. 概述



### 1.1 架构说明



参赛系统采用 **Agent 网关 + Agent 引擎** 的架构：

- **Agent 网关**：面向业务，负责会话管理、消息路由、权限控制等

- **Agent 引擎**：面向智能执行，负责实际的 LLM 调用和工具执行



参赛者需要实现一个符合本规范的 Agent 网关，该网关需要：

1. 支持至少 2 种不同的 Agent 引擎（harness）

2. 启动时通过配置指定使用的引擎（不同引擎分别启动，无需运行时动态切换）

3. 实现本规范定义的所有 HTTP API 接口



### 1.2 设计原则



- **RESTful 风格**：所有接口遵循 RESTful 设计规范

- **JSON 格式**：请求和响应均使用 JSON 格式

- **SSE 实时推送**：通过 Server-Sent Events 实现实时事件推送

- **状态管理**：网关需要维护会话状态（idle/busy）



---



## 2. 基础信息



### 2.1 启动方式



参赛者可以自由选择技术框架实现网关。启动时通过命令行参数指定使用的引擎：



```bash

# 启动网关，指定使用引擎 A

gateway --engine engine-a --port 6217



# 启动网关，指定使用引擎 B

gateway --engine engine-b --port 6217

```



**启动参数**



| 参数 | 必填 | 说明 |

|------|------|------|

| `--engine` | 是 | 引擎标识符，如 `opencode`、`hermes` |

| `--port` | 否 | 服务端口，默认 6217 |

| `--host` | 否 | 监听地址，默认 `localhost` |



**引擎切换方式**



参赛者需要支持至少 2 种引擎，通过启动参数切换：



```bash

# 第一次评测：使用引擎 A

gateway --engine opencode



# 第二次评测：使用引擎 B

gateway --engine hermes

```



比赛会在不同轮次使用不同引擎启动网关，分别进行评测。



**实现方式**



参赛者可以选择以下方式之一：



1. **从零实现**：使用任意编程语言和技术框架，实现本规范定义的所有接口

2. **基于 myagent 修改**：在提供的 myagent 代码基础上进行扩展，接入新的 Agent 引擎



### 2.2 服务地址



- **默认端口**：6217

- **协议**：HTTP/1.1

- **Content-Type**：`application/json`



### 2.3 通用查询参数



部分接口支持以下查询参数：



| 参数名 | 类型 | 必填 | 说明 |

|--------|------|------|------|

| `directory` | string | 否 | 工作目录路径，用于隔离不同项目的会话和配置 |



### 2.4 会话状态



会话有两种状态：

- **idle**：空闲状态，可以接受新的用户输入

- **busy**：忙碌状态，正在处理用户请求



---



## 3. 会话管理接口



### 3.1 创建会话



创建一个新的会话。



**请求**



```http

POST /session

Content-Type: application/json



{

  "title": "会话标题"

}

```



**响应**



```json

{

  "id": "ses_abc123",

  "title": "会话标题",

  "created_at": "2026-08-21T10:00:00Z",

  "status": "idle"

}

```



**字段说明**



| 字段 | 类型 | 说明 |

|------|------|------|

| `id` | string | 会话唯一标识 |

| `title` | string | 会话标题 |

| `created_at` | string | 创建时间（ISO 8601） |

| `status` | string | 初始状态，固定为 `idle` |



---



### 3.2 获取会话信息



获取指定会话的详细信息。



**请求**



```http

GET /session/{session_id}

```



**响应**



```json

{

  "id": "ses_abc123",

  "title": "会话标题",

  "created_at": "2026-08-21T10:00:00Z",

  "status": "idle",

  "message_count": 5

}

```



---



### 3.3 删除会话



删除指定会话及其所有消息。



**请求**



```http

DELETE /session/{session_id}

```



**响应**



```json

{

  "ok": true

}

```



---



### 3.4 获取所有会话状态



获取所有会话的当前状态。



**请求**



```http

GET /session/status

```



**响应**



```json

{

  "ses_abc123": {

    "type": "idle"

  },

  "ses_def456": {

    "type": "busy"

  }

}

```



**字段说明**



| 字段 | 类型 | 说明 |

|------|------|------|

| `{session_id}` | object | 会话 ID 作为 key |

| `type` | string | 会话状态：`idle` 或 `busy` |



---



## 4. 消息交互接口



### 4.1 发送用户消息



向指定会话发送用户消息并触发 Agent 处理。**此接口会阻塞直到本轮处理完成**。



**请求**



```http

POST /session/{session_id}/prompt_async

Content-Type: application/json



{

  "parts": [

    {

      "type": "text",

      "text": "用户的问题或指令"

    }

  ],

  "model": {

    "providerID": "provider_xxx",

    "modelID": "gpt-4"

  },

  "agent": "assistant"

}

```



**请求体字段**



| 字段 | 类型 | 必填 | 说明 |

|------|------|------|------|

| `parts` | array | 是 | 消息部分数组，目前只支持 `text` 类型 |

| `parts[].type` | string | 是 | 固定为 `text` |

| `parts[].text` | string | 是 | 用户输入的文本内容 |

| `model` | object | 是 | 模型配置 |

| `model.providerID` | string | 是 | Provider ID |

| `model.modelID` | string | 是 | 模型 ID |

| `agent` | string | 否 | Agent 类型，默认 `assistant` |



**响应**



```http

HTTP/1.1 204 No Content

```



**说明**



- 此接口会阻塞直到本轮处理完成（包括所有工具调用和最终回复）

- 如果 Agent 需要反问或请求权限，会通过 SSE 事件通知

- 客户端需要在后台线程调用此接口，同时监听 SSE 事件



---



### 4.2 获取会话消息



获取指定会话的所有消息。



**请求**



```http

GET /session/{session_id}/message

```



**响应**



```json

[

  {

    "id": "msg_001",

    "role": "user",

    "content": "用户的问题",

    "created_at": "2026-08-21T10:00:00Z"

  },

  {

    "id": "msg_002",

    "role": "assistant",

    "content": "助手的回复",

    "tool_calls": [

      {

        "id": "call_001",

        "name": "search",

        "arguments": {

          "query": "关键词"

        }

      }

    ],

    "created_at": "2026-08-21T10:00:05Z",

    "info": {

      "role": "assistant",

      "finish": "stop"

    },

    "parts": [

      {

        "type": "text",

        "content": "这是回复内容"

      },

      {

        "type": "tool",

        "tool": "search",

        "state": {

          "status": "completed",

          "title": "搜索完成"

        }

      },

      {

        "type": "step-finish"

      }

    ]

  },

  {

    "id": "msg_003",

    "role": "tool",

    "tool_call_id": "call_001",

    "tool_name": "search",

    "content": "搜索结果..."

  }

]

```



**消息字段说明**



| 字段 | 类型 | 说明 |

|------|------|------|

| `id` | string | 消息唯一标识 |

| `role` | string | 消息角色：`user`、`assistant`、`tool` |

| `content` | string | 消息内容（user/assistant/tool） |

| `tool_calls` | array | 工具调用列表（仅 assistant） |

| `tool_calls[].id` | string | 工具调用 ID |

| `tool_calls[].name` | string | 工具名称 |

| `tool_calls[].arguments` | object | 工具参数 |

| `tool_call_id` | string | 关联的工具调用 ID（仅 tool） |

| `tool_name` | string | 工具名称（仅 tool） |

| `created_at` | string | 创建时间（ISO 8601） |

| `info` | object | 消息元信息（仅 assistant） |

| `info.role` | string | 固定为 `assistant` |

| `info.finish` | string | 完成原因：`stop`、`tool-calls` 等 |

| `parts` | array | 消息部分数组（仅 assistant） |

| `parts[].type` | string | 部分类型：`text`、`tool`、`step-finish` |



**重要说明**



- `parts` 数组中的 `step-finish` 表示一次 LLM step 结束

- 当 `info.finish` 为 `tool-calls` 时，Agent 会继续执行工具调用，不能视为本轮结束

- 只有当 `info.finish` 为 `stop` 且存在 `step-finish` 时，才表示最终回复完成



---



### 4.3 中止会话生成



中止指定会话的当前生成过程。



**请求**



```http

POST /session/{session_id}/abort

```



**响应**



```json

{

  "ok": true

}

```



**备选路径**



```http

POST /session/{session_id}/stop

```



---



## 5. 交互处理接口



### 5.1 获取待处理问题



获取所有待处理的用户问题（Agent 反问场景）。



**请求**



```http

GET /question

```



**响应**



```json

[

  {

    "id": "req_001",

    "sessionID": "ses_abc123",

    "questions": [

      {

        "question": "您希望使用哪种方案？",

        "options": [

          {

            "label": "方案 A",

            "description": "方案 A 的详细说明"

          },

          {

            "label": "方案 B",

            "description": "方案 B 的详细说明"

          }

        ]

      }

    ],

    "created_at": "2026-08-21T10:00:10Z"

  }

]

```



**字段说明**



| 字段 | 类型 | 说明 |

|------|------|------|

| `id` | string | 问题请求 ID |

| `sessionID` | string | 所属会话 ID |

| `questions` | array | 问题列表 |

| `questions[].question` | string | 问题文本 |

| `questions[].options` | array | 选项列表 |

| `questions[].options[].label` | string | 选项标签 |

| `questions[].options[].description` | string | 选项描述 |



---



### 5.2 回复问题



回复 Agent 提出的反问。



**请求**



```http

POST /question/{request_id}/reply

Content-Type: application/json



{

  "answers": [

    ["方案 A"]

  ]

}

```



**请求体字段**



| 字段 | 类型 | 必填 | 说明 |

|------|------|------|------|

| `answers` | array | 是 | 答案数组，每个元素对应一个问题 |

| `answers[]` | array | 是 | 单个问题的答案数组（支持多选） |



**响应**



```json

{

  "ok": true

}

```



---



### 5.3 获取待处理权限请求



获取所有待处理的权限请求。



**请求**



```http

GET /permission

```



**响应**



```json

[

  {

    "id": "perm_001",

    "sessionID": "ses_abc123",

    "permission": "file.write",

    "patterns": [

      "/path/to/file.txt"

    ],

    "created_at": "2026-08-21T10:00:15Z"

  }

]

```



**字段说明**



| 字段 | 类型 | 说明 |

|------|------|------|

| `id` | string | 权限请求 ID |

| `sessionID` | string | 所属会话 ID |

| `permission` | string | 权限类型（如 `file.write`、`bash.execute`） |

| `patterns` | array | 权限匹配模式（如文件路径、命令） |



---



### 5.4 回复权限请求



回复 Agent 的权限请求。



**请求**



```http

POST /permission/{request_id}/reply

Content-Type: application/json



{

  "reply": "always",

  "message": "允许所有文件写入操作"

}

```



**请求体字段**



| 字段 | 类型 | 必填 | 说明 |

|------|------|------|------|

| `reply` | string | 是 | 回复类型：`once`（单次允许）、`always`（永久允许）、`reject`（拒绝） |

| `message` | string | 否 | 附加消息 |



**响应**



```json

{

  "ok": true

}

```



---



## 6. SSE 事件流接口



### 6.1 全局事件流



通过 Server-Sent Events 接收实时事件推送。



**请求**



```http

GET /event

Accept: text/event-stream

```



**响应头**



```http

HTTP/1.1 200 OK

Content-Type: text/event-stream; charset=utf-8

Cache-Control: no-cache

Connection: keep-alive

X-Accel-Buffering: no

```



**事件格式**



```

data: {"type": "event.type", "properties": {...}}



```



**支持的事件类型**



#### 6.1.1 连接事件



**server.connected** - SSE 连接建立成功



```json

{

  "type": "server.connected",

  "properties": {}

}

```



**server.heartbeat** - 心跳事件（每 15 秒）



```json

{

  "type": "server.heartbeat",

  "properties": {}

}

```



#### 6.1.2 会话状态事件



**session.status** - 会话状态变更



```json

{

  "type": "session.status",

  "properties": {

    "sessionID": "ses_abc123",

    "status": {

      "type": "busy"

    }

  }

}

```



```json

{

  "type": "session.status",

  "properties": {

    "sessionID": "ses_abc123",

    "status": {

      "type": "idle"

    }

  }

}

```



**session.idle** - 会话进入空闲状态



```json

{

  "type": "session.idle",

  "properties": {

    "sessionID": "ses_abc123"

  }

}

```



**session.error** - 会话发生错误



```json

{

  "type": "session.error",

  "properties": {

    "sessionID": "ses_abc123",

    "error": {

      "message": "错误详情",

      "data": {

        "responseBody": "..."

      }

    }

  }

}

```



#### 6.1.3 消息事件



**message.part.updated** - 消息部分更新



```json

{

  "type": "message.part.updated",

  "properties": {

    "sessionID": "ses_abc123",

    "messageID": "msg_002",

    "part": {

      "type": "text",

      "content": "这是回复内容"

    }

  }

}

```



```json

{

  "type": "message.part.updated",

  "properties": {

    "sessionID": "ses_abc123",

    "messageID": "msg_002",

    "part": {

      "type": "tool",

      "tool": "search",

      "state": {

        "status": "running",

        "title": "正在搜索..."

      }

    }

  }

}

```



```json

{

  "type": "message.part.updated",

  "properties": {

    "sessionID": "ses_abc123",

    "messageID": "msg_002",

    "part": {

      "type": "step-finish"

    }

  }

}

```



**part 类型说明**



| type | 说明 | 关键字段 |

|------|------|----------|

| `text` | 文本内容 | `content` |

| `tool` | 工具调用 | `tool`（工具名）、`state.status`（running/completed）、`state.title` |

| `step-finish` | LLM step 结束 | 无额外字段 |



#### 6.1.4 交互事件



**question.asked** - Agent 提出反问



```json

{

  "type": "question.asked",

  "properties": {

    "sessionID": "ses_abc123",

    "id": "req_001",

    "questions": [

      {

        "question": "您希望使用哪种方案？",

        "options": [

          {

            "label": "方案 A",

            "description": "方案 A 的详细说明"

          }

        ]

      }

    ]

  }

}

```



**permission.asked** - Agent 请求权限



```json

{

  "type": "permission.asked",

  "properties": {

    "sessionID": "ses_abc123",

    "id": "perm_001",

    "permission": "file.write",

    "patterns": [

      "/path/to/file.txt"

    ]

  }

}

```



---



## 7. 错误处理



### 7.1 错误响应格式



所有错误响应遵循以下格式：



```json

{

  "code": "ERROR_CODE",

  "message": "错误描述信息"

}

```



### 7.2 常见错误码



| HTTP 状态码 | 错误码 | 说明 |

|------------|--------|------|

| 400 | `VALIDATION_ERROR` | 请求参数验证失败 |

| 404 | `NOT_FOUND` | 资源不存在（如会话不存在） |

| 500 | `INTERNAL_ERROR` | 服务器内部错误 |

| 502 | `BAD_GATEWAY` | 上游引擎调用失败 |

| 503 | `SERVICE_UNAVAILABLE` | 服务暂不可用 |



### 7.3 错误示例



**会话不存在**



```http

HTTP/1.1 404 Not Found

Content-Type: application/json



{

  "code": "NOT_FOUND",

  "message": "Session not found"

}

```



**参数验证失败**



```http

HTTP/1.1 400 Bad Request

Content-Type: application/json



{

  "code": "VALIDATION_ERROR",

  "message": "title is required"

}

```



---



## 8. 完整交互流程



### 8.1 标准对话流程



```

客户端                          网关                          Agent 引擎

  |                              |                              |

  |-- POST /session ------------>|                              |

  |<-- 200 {id: "ses_abc123"} ---|                              |

  |                              |                              |

  |-- GET /event (SSE) --------->|                              |

  |<-- 200 server.connected -----|                              |

  |                              |                              |

  |-- POST /session/.../prompt_async ------------------------->|

  |                              |                              |

  |<-- session.status busy ------|<-----------------------------|

  |<-- message.part.updated -----|<-----------------------------|

  |<-- message.part.updated -----|<-----------------------------|

  |<-- session.status idle ------|<-----------------------------|

  |                              |                              |

  |<-- 204 No Content -----------|                              |

  |                              |                              |

  |-- GET /session/.../message ->|                              |

  |<-- 200 [messages] ----------|                              |

```



### 8.2 反问交互流程



```

客户端                          网关                          Agent 引擎

  |                              |                              |

  |-- POST /session/.../prompt_async ------------------------->|

  |                              |                              |

  |<-- session.status busy ------|<-----------------------------|

  |<-- question.asked ----------|<-----------------------------|

  |                              |                              |

  |-- GET /question ------------>|                              |

  |<-- 200 [questions] ---------|                              |

  |                              |                              |

  |-- POST /question/.../reply ->|---------------------------->|

  |<-- 200 {ok: true} ---------|                              |

  |                              |                              |

  |<-- session.status idle ------|<-----------------------------|

  |<-- 204 No Content ----------|                              |

```



### 8.3 权限请求流程



```

客户端                          网关                          Agent 引擎

  |                              |                              |

  |-- POST /session/.../prompt_async ------------------------->|

  |                              |                              |

  |<-- session.status busy ------|<-----------------------------|

  |<-- permission.asked --------|<-----------------------------|

  |                              |                              |

  |-- GET /permission ---------->|                              |

  |<-- 200 [permissions] -------|                              |

  |                              |                              |

  |-- POST /permission/.../reply ->|-------------------------->|

  |<-- 200 {ok: true} ---------|                              |

  |                              |                              |

  |<-- session.status idle ------|<-----------------------------|

  |<-- 204 No Content ----------|                              |

```



### 8.4 判断本轮完成的规则



客户端通过以下规则判断一轮对话是否完成：



1. **监听 SSE 事件**：

   - 收到 `session.status` 且 `type` 为 `idle`

   - 或收到 `session.idle` 事件

   - 或收到 `session.error` 事件



2. **轮询兜底**：

   - 调用 `GET /session/status` 检查会话状态

   - 调用 `GET /session/{id}/message` 检查最后一条消息



3. **最终消息检查**：

   - 最后一条消息的 `role` 为 `assistant`

   - `info.finish` 为 `stop`（不是 `tool-calls`）

   - `parts` 数组包含 `step-finish` 类型的部分



**注意**：仅看到 `step-finish` 不足以判断完成，必须结合 `info.finish` 字段。当 `finish` 为 `tool-calls` 时，Agent 会继续执行工具调用。



---



## 附录 A：实现建议



### A.1 启动时引擎选择



以下示例使用 TypeScript 演示启动时引擎选择的实现思路，参赛者可以使用任意编程语言：



```typescript

// 引擎接口定义

interface AgentEngine {

  createSession(title: string): Promise<Session>;

  // ... 其他接口方法

}



// 引擎工厂：根据启动参数创建对应引擎实例

function createEngine(name: string): AgentEngine {

  switch (name) {

    case 'opencode':

      return new OpenCodeEngine();

    case 'hermes':

      return new HermesEngine();

    default:

      throw new Error(`Unknown engine: ${name}`);

  }

}



// 启动入口

const args = parseArgs(); // 解析 --engine, --port, --host 参数

const engine = createEngine(args.engine);

const server = new GatewayServer(engine, args.port);

server.start();

```



**基于 myagent 实现的参赛者**：



myagent 项目已经实现了完整的网关层（`packages/agent/src/http/`），参赛者可以：

1. 复用现有网关代码，替换或新增引擎适配层

2. 参考 `packages/agent/src/adapters/` 实现新的引擎适配器

3. 确保最终启动命令支持 `--engine` 参数切换引擎



### A.2 会话状态管理



以下示例仅供参考，参赛者可使用任意技术栈实现。



**TypeScript 示例**



```typescript

class SessionStateManager {

  private sessions: Map<string, SessionState> = new Map();

 

  setState(sessionId: string, state: 'idle' | 'busy'): void {

    const session = this.sessions.get(sessionId);

    if (session) {

      session.status = state;

    }

  }

 

  getState(sessionId: string): 'idle' | 'busy' | undefined {

    return this.sessions.get(sessionId)?.status;

  }

 

  getAllStates(): Record<string, { type: string }> {

    const result: Record<string, { type: string }> = {};

    for (const [id, state] of this.sessions.entries()) {

      result[id] = { type: state.status };

    }

    return result;

  }

}

```



### A.3 SSE 事件广播



以下示例仅供参考，参赛者可使用任意技术栈实现。



**TypeScript 示例**



```typescript

class EventHub {

  private subscribers: Set<(event: Event) => void> = new Set();

 

  subscribe(callback: (event: Event) => void): () => void {

    this.subscribers.add(callback);

    return () => this.subscribers.delete(callback);

  }

 

  emit(event: Event): void {

    for (const callback of this.subscribers) {

      try {

        callback(event);

      } catch (error) {

        console.error('Event subscriber error:', error);

      }

    }

  }

}

```



---



## 附录 B：测试检查清单



实现完成后，请确保以下功能正常工作：



- [ ] 能够创建、获取、删除会话

- [ ] 能够发送用户消息并接收 Agent 回复

- [ ] 能够正确处理 Agent 反问场景

- [ ] 能够正确处理 Agent 权限请求

- [ ] SSE 事件流能够正常推送所有事件类型

- [ ] 会话状态能够正确切换（idle ↔ busy）

- [ ] 能够中止正在进行的生成过程

- [ ] 错误响应格式正确，包含错误码和描述信息

- [ ] 支持 `directory` 参数实现项目隔离

- [ ] 至少支持 2 种不同的 Agent 引擎

- [ ] 启动时通过 `--engine` 参数切换引擎



---



## 附录 C：参考实现



**网关实现参考**



参赛者可以基于 `myagent` 项目代码进行修改参赛：

- `myagent/packages/agent/src/http/` - 网关 HTTP 路由层

- `myagent/packages/agent/src/adapters/` - 引擎适配层

- `myagent/packages/agent/src/services/` - 业务服务层



---



**文档版本**：1.1  

**最后更新**：2026-08-21