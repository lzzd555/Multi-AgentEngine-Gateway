# MyAgent 网关接口文档

> **服务地址**: `http://localhost:3008`  
> **协议**: HTTP/1.1  
> **Content-Type**: `application/json`  
> **文档版本**: 1.0  
> **最后更新**: 2026-09-02

---

## 目录

- [一、评测核心接口](#一评测核心接口)（评测脚本直接调用的 8 个接口，如果没有权限和question工具，反问和权限接口可选实现）
  - [1.1 创建 Agent](#11-创建-agent)
  - [1.2 发送任务消息](#12-发送任务消息)
  - [1.3 SSE 全局事件流](#13-sse-全局事件流)
  - [1.4 获取会话消息](#14-获取会话消息)
  - [1.5 删除 Agent](#15-删除-agent)
  - [1.6 中止任务](#16-中止任务)
  - [1.7 回复 Agent 反问](#17-回复-agent-反问)
  - [1.8 回复权限请求](#18-回复权限请求)
- [二、Agent 管理接口（供参考，非必选）](#二agent-管理接口)
  - [2.1 反查 Agent](#21-反查-agent)
  - [2.2 聊天队列](#22-聊天队列)
  - [2.3 清空聊天](#23-清空聊天)
  - [2.4 聊天记忆](#24-聊天记忆)
  - [2.5 会话压缩](#25-会话压缩)
- [三、OpenCode 配置接口（供参考，非必选，其他引擎兼容配置需要考虑）](#三opencode-配置接口)
- [四、本地网关代理接口（供参考，非必选）](#四本地网关代理接口)
- [五、健康检查与其他（供参考，非必选）](#五健康检查与其他)
- [六、错误处理（供参考，非必选）](#六错误处理)
- [七、SSE 事件类型参考](#七sse-事件类型参考)
- [八、评测完整交互流程](#八评测完整交互流程)

---



## 一、评测核心接口（选手实现以下接口即可支撑评测）

> 以下 8 个接口是评测脚本直接调用的接口。

注：myagent网关层接口，大部分带opencode前缀，因为系统设计时选择opencode作为第一个接入的引擎，所以以opencode协议作为了系统规范，其他引擎接入需要实现面向opencode协议的适配层

### 1.1 创建 Agent

创建一个新的 Agent 实例。每个评测用例对应一个 Agent。

注：底层实际可以复用agent，只创建一个session

```
POST /v1/agents
```

**请求体**

```json
{
  "name": "eval-agent",
  "directory": "D:/workspace"
}
```


| 字段            | 类型     | 必填  | 说明               |
| ------------- | ------ | --- | ---------------- |
| `name`        | string | 是   | Agent 名称         |
| `directory`   | string | 否   | 工作目录路径           |
| `description` | string | 否   | Agent 描述         |
| `headImgUrl`  | string | 否   | 人设头像链接           |
| `session_id`  | string | 否   | 绑定已有的 session ID |


**响应** `201 Created`

```json
{
  "agent_id": "27b0bbe2-827f-49ee-a7cb-e784c77edb2c",
  "project_dir": "D:\\workspace"
}
```


| 字段            | 类型     | 说明                  |
| ------------- | ------ | ------------------- |
| `agent_id`    | string | Agent 唯一标识（UUID 格式） |
| `project_dir` | string | 实际工作目录绝对路径          |


---



### 1.2 发送任务消息

向指定 Agent 发送用户消息并触发任务执行。**此接口会阻塞直到本轮处理完成**。

```
POST /v1/agents/{agent_id}/chat
```

**请求体**

```json
{
  "text": "给y00942037发一条消息：你好",
  "mode": "task",
  "trace_id": "74c09059-0739-445f-a9b4-cf9425c157fd",
  "requestContext": {
    "trigger": "interactive",
    "channel": "dm"
  },
  "model": {
    "providerID": "myprovider_1780386986533",
    "modelID": "maas-glm-5.2-zhipu"
  }
}
```


| 字段                                 | 类型      | 必填           | 说明                               |
| ---------------------------------- | ------- | ------------ | -------------------------------- |
| `text`                             | string  | 是            | 用户输入的文本内容                        |
| `mode`                             | string  | 是            | 模式，固定为 `task`（评测用）或 `chat`       |
| `trace_id`                         | string  | 是            | 本次请求的唯一追踪 ID                     |
| `requestContext`                   | object  | 否            | 请求上下文                            |
| `requestContext.trigger`           | string  | 否            | 触发方式：`interactive` / `scheduled` |
| `requestContext.channel`           | string  | 否            | 通道：`dm`（私聊）/ `group`（群聊）         |
| `requestContext.groupId`           | string  | 否            | 群聊时必填，群 ID                       |
| `requestContext.groupName`         | string  | 否            | 群聊展示名                            |
| `requestContext.groupSenderName`   | string  | 否            | 群内发送者展示名（仅 group）                |
| `requestContext.groupSenderUuid`   | string  | 否            | 群内发送者 UUID（仅 group）              |
| `requestContext.cloudChannelReply` | boolean | 否            | 是否通过实时通道回传流式 payload（仅 task 模式）  |
| `model`                            | object  | 否            | 模型配置                             |
| `model.providerID`                 | string  | 是（model 存在时） | Provider ID                      |
| `model.modelID`                    | string  | 是（model 存在时） | 模型 ID                            |
| `attachments`                      | array   | 否            | 附件列表                             |


**响应** `200 OK`

阻塞直到本轮处理完成后返回。返回内容包含 `session_id`（OpenCode 引擎层 session ID）。

**注意**

- 此接口阻塞直到本轮处理完成（包括所有工具调用和最终回复）
- 如果 Agent 需要反问或请求权限，会通过 SSE 事件推送
- 客户端需要在后台线程调用此接口，同时监听 SSE 事件处理交互

---



### 1.3 SSE 全局事件流

通过 Server-Sent Events 接收实时事件推送。全局事件流包含所有 Agent 的事件，客户端需按 `agent_id` 过滤。

```
GET /v1/events
Accept: text/event-stream
```

**响应头**

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**事件格式**

每条 SSE 事件为 JSON 格式的 BridgeEvent 信封：

```
data: {"agent_id":"27b0bbe2-...","trace_id":"74c09059-...","payload":{"type":"session.status","properties":{"sessionID":"ses_xxx","status":{"type":"idle"}}}}

```


| 字段                   | 类型     | 说明                |
| -------------------- | ------ | ----------------- |
| `agent_id`           | string | 所属 Agent ID（用于过滤） |
| `trace_id`           | string | 关联的追踪 ID（可选）      |
| `child_session_id`   | string | 子会话 ID（可选）        |
| `payload.type`       | string | 事件类型              |
| `payload.properties` | object | 事件属性              |


**心跳**: 每 15 秒发送一次 `: heartbeat\n\n` 注释行。

**连接建立**: 连接成功后立即发送 `: bridge\n\n` 注释行。

详细事件类型参见 [七、SSE 事件类型参考](#七sse-事件类型参考)。

---



### 1.4 获取会话消息

获取指定session 的所有消息。用于评测完成后采集对话快照。

```
GET /v1/config/opencode/session/{session_id}/message
```

**路径参数**


| 参数           | 类型     | 说明                               |
| ------------ | ------ | -------------------------------- |
| `session_id` | string | session ID（从 chat 响应或 SSE 事件中获取） |


**响应** `200 OK`

```json
[
  {
    "id": "msg_001",
    "role": "user",
    "content": "用户的问题",
    "created_at": "2026-09-02T10:00:00Z"
  },
  {
    "id": "msg_002",
    "role": "assistant",
    "content": "助手的回复文本",
    "tool_calls": [
      {
        "id": "call_001",
        "name": "bash",
        "arguments": { "command": "ls -la" }
      }
    ],
    "created_at": "2026-09-02T10:00:05Z",
    "info": {
      "role": "assistant",
      "finish": "stop"
    },
    "parts": [
      { "type": "text", "content": "这是回复内容" },
      {
        "type": "tool",
        "tool": "bash",
        "state": { "status": "completed", "title": "执行完成" }
      },
      { "type": "step-finish" }
    ],
    "tokens": {
      "total": 1500,
      "input": 1000,
      "output": 500,
      "reasoning": 0,
      "cache": { "read": 800, "write": 0 }
    }
  },
  {
    "id": "msg_003",
    "role": "tool",
    "tool_call_id": "call_001",
    "tool_name": "bash",
    "content": "total 8\ndrwxr-xr-x 2 user group 4096 ..."
  }
]
```

**消息字段说明**


| 字段                       | 类型          | 说明                                      |
| ------------------------ | ----------- | --------------------------------------- |
| `id`                     | string      | 消息唯一标识                                  |
| `role`                   | string      | 消息角色：`user` / `assistant` / `tool`      |
| `content`                | string/null | 消息内容                                    |
| `tool_calls`             | array       | 工具调用列表（仅 assistant）                     |
| `tool_calls[].id`        | string      | 工具调用 ID                                 |
| `tool_calls[].name`      | string      | 工具名称                                    |
| `tool_calls[].arguments` | object      | 工具参数                                    |
| `tool_call_id`           | string      | 关联的工具调用 ID（仅 tool）                      |
| `tool_name`              | string      | 工具名称（仅 tool）                            |
| `info`                   | object      | 消息元信息（仅 assistant）                      |
| `info.finish`            | string      | 完成原因：`stop`（最终回复）/ `tool-calls`（继续执行工具） |
| `parts`                  | array       | 消息部分数组（仅 assistant）                     |
| `parts[].type`           | string      | `text` / `tool` / `step-finish`         |
| `tokens`                 | object      | token 使用统计（仅 assistant）                 |


**判断本轮完成的规则**

1. 最后一条消息 `role` 为 `assistant`
2. `info.finish` 为 `stop`（不是 `tool-calls`）
3. `parts` 数组包含 `step-finish` 类型

> 仅看到 `step-finish` 不足以判断完成，必须结合 `info.finish` 字段。当 `finish` 为 `tool-calls` 时，Agent 会继续执行工具调用。

---



### 1.5 删除 Agent

删除指定 Agent 及其关联的会话数据。

```
DELETE /v1/agents/{agent_id}
```

**查询参数**


| 参数            | 类型     | 必填  | 说明                             |
| ------------- | ------ | --- | ------------------------------ |
| `skipPersona` | string | 否   | 设为 `1` 或 `true` 时跳过 persona 清理 |


**响应** `200 OK`

```json
{
  "ok": true
}
```

---



### 1.6 中止任务

中止指定 Agent 当前正在执行的任务。

```
POST /v1/agents/{agent_id}/chat/pause
```

**请求体**

```json
{
  "mode": "task"
}
```


| 字段     | 类型     | 必填  | 说明                 |
| ------ | ------ | --- | ------------------ |
| `mode` | string | 是   | 模式：`task` 或 `chat` |


**响应** `200 OK`

```json
{
  "ok": true,
  "paused": true
}
```

**错误响应**


| 状态码 | 错误码                | 说明                 |
| --- | ------------------ | ------------------ |
| 400 | `VALIDATION_ERROR` | mode 参数无效          |
| 404 | `NO_ACTIVE_CHAT`   | 没有正在执行的聊天          |
| 502 | `BAD_GATEWAY`      | 中止上游 OpenCode 任务失败 |


---



### 1.7 回复 Agent 反问

当 Agent 通过 SSE 事件 `question.asked` 提出反问时，使用此接口回复。

```
POST /v1/opencode/session/question/reply
```

**请求体**

```json
{
  "requestID": "req_001",
  "answers": [["方案 A"]],
  "directory": "D:/workspace",
  "agentId": "27b0bbe2-827f-49ee-a7cb-e784c77edb2c"
}
```


| 字段          | 类型         | 必填  | 说明                                   |
| ----------- | ---------- | --- | ------------------------------------ |
| `requestID` | string     | 是   | 问题请求 ID（从 `question.asked` SSE 事件获取） |
| `answers`   | string[][] | 是   | 答案数组，每个元素对应一个问题的答案（支持多选）             |
| `directory` | string     | 否   | 工作目录                                 |
| `agentId`   | string     | 否   | Agent ID                             |


**响应** `200 OK`

```json
{
  "ok": true
}
```

---



### 1.8 回复权限请求

当 Agent 通过 SSE 事件 `permission.asked` 请求权限时，使用此接口回复。

```
POST /v1/opencode/session/permission/respond
```

**请求体**

```json
{
  "response": "always",
  "sessionID": "ses_fa2e10896ffe7uyErMSUtjsEs4",
  "permissionID": "per_05d0277b9001X5MG6jfi4ySC8m",
  "directory": "D:/workspace",
  "agentId": "27b0bbe2-827f-49ee-a7cb-e784c77edb2c"
}
```


| 字段             | 类型     | 必填  | 说明                                              |
| -------------- | ------ | --- | ----------------------------------------------- |
| `response`     | string | 是   | 回复类型：`once`（单次允许）/ `always`（永久允许）/ `reject`（拒绝） |
| `sessionID`    | string | 是   | OpenCode session ID                             |
| `permissionID` | string | 是   | 权限请求 ID（从 `permission.asked` SSE 事件获取）          |
| `directory`    | string | 否   | 工作目录                                            |
| `agentId`      | string | 否   | Agent ID                                        |


**响应** `200 OK`

```json
{
  "ok": true
}
```

---



## 二、Agent 管理接口



### 2.1 反查 Agent

根据 OpenCode session_id 反查对应的 agent_id。

```
GET /v1/agents/resolve-session?session_id={session_id}
```

**查询参数**


| 参数           | 类型     | 必填  | 说明                  |
| ------------ | ------ | --- | ------------------- |
| `session_id` | string | 是   | OpenCode session ID |


**响应** `200 OK`

```json
{
  "agent_id": "27b0bbe2-827f-49ee-a7cb-e784c77edb2c",
  "slot": 0
}
```

**错误响应**


| 状态码 | 错误码                | 说明              |
| --- | ------------------ | --------------- |
| 400 | `VALIDATION_ERROR` | session_id 参数缺失 |
| 404 | `NOT_FOUND`        | session 不存在     |


---



### 2.2 聊天队列

获取指定 Agent 的聊天任务队列。

```
GET /v1/agents/{agent_id}/chat/queue
```

**响应** `200 OK`

```json
{
  "items": [
    {
      "trace_id": "xxx",
      "text": "用户消息",
      "status": "queued"
    }
  ]
}
```

删除队列中的指定任务：

```
DELETE /v1/agents/{agent_id}/chat/queue/{trace_id}
```

**响应** `200 OK`

```json
{ "ok": true }
```

---



### 2.3 清空聊天

清空指定 Agent 的聊天记录。

```
POST /v1/agents/{agent_id}/chat/clear
```

**请求体**

```json
{
  "mode": "task",
  "requestContext": {
    "trigger": "interactive",
    "channel": "dm"
  }
}
```


| 字段               | 类型     | 必填  | 说明                         |
| ---------------- | ------ | --- | -------------------------- |
| `mode`           | string | 是   | `task` 或 `chat`            |
| `requestContext` | object | 否   | 请求上下文（task 模式用于定位要清的 slot） |


**响应** `200 OK`

```json
{ "ok": true }
```

---



### 2.4 聊天记忆

管理指定 Agent 的聊天记忆。

```
POST /v1/agents/{agent_id}/chat/memory
```

---



### 2.5 会话压缩

对指定 Agent 的会话进行上下文压缩。

```
POST /v1/agents/{agent_id}/session/compact
```

---



## 三、OpenCode 配置接口

> 以下接口前缀为 `/v1/config/opencode/`，用于管理和查询 OpenCode 全局配置。



### 3.1 配置查询


| 方法  | 路径                                          | 说明                 |
| --- | ------------------------------------------- | ------------------ |
| GET | `/v1/config/opencode/global/user`           | 获取用户层配置            |
| GET | `/v1/config/opencode/global/weclaw`         | 获取 WeClaw 层配置      |
| GET | `/v1/config/opencode/global`                | 获取合并后的全局配置总览       |
| GET | `/v1/config/opencode/global/models`         | 获取可用模型列表           |
| GET | `/v1/config/opencode/global/models/builtin` | 获取内置模型列表           |
| GET | `/v1/config/opencode/global/commands`       | 获取可用命令列表（含 Skills） |
| GET | `/v1/config/opencode/global/mcp`            | 获取 MCP 服务配置        |
| GET | `/v1/config/opencode/global/analysis-model` | 获取分析模型配置           |
| GET | `/v1/config/opencode/ready`                 | 检查 OpenCode 是否就绪   |




### 3.2 配置修改


| 方法     | 路径                                                  | 说明             |
| ------ | --------------------------------------------------- | -------------- |
| PUT    | `/v1/config/opencode/global/analysis-model`         | 设置分析模型         |
| DELETE | `/v1/config/opencode/global/analysis-model`         | 删除分析模型         |
| PUT    | `/v1/config/opencode/global/models/provider`        | 添加/更新 Provider |
| DELETE | `/v1/config/opencode/global/models/provider/:id`    | 删除 Provider    |
| POST   | `/v1/config/opencode/global/models/provider-toggle` | 启用/禁用 Provider |
| POST   | `/v1/config/opencode/global/models/refresh`         | 刷新模型列表         |
| PUT    | `/v1/config/opencode/global/authorization-settings` | 设置授权规则         |
| PUT    | `/v1/config/opencode/global/permission`             | 设置权限规则         |
| POST   | `/v1/config/opencode/global/mcp/toggle`             | 启用/禁用 MCP      |
| PUT    | `/v1/config/opencode/global/mcp`                    | 添加/更新 MCP      |
| DELETE | `/v1/config/opencode/global/mcp/:name`              | 删除 MCP         |
| POST   | `/v1/config/opencode/global/reload`                 | 重新加载配置         |
| POST   | `/v1/config/opencode/warmup`                        | 预热 MCP 连接      |




### 3.3 Session 数据接口


| 方法   | 路径                                        | 说明                |
| ---- | ----------------------------------------- | ----------------- |
| GET  | `/v1/config/opencode/session/:id/message` | 获取会话消息列表          |
| POST | `/v1/opencode/db/sessions/archive`        | 归档 session        |
| GET  | `/v1/opencode/db/sessions/migratable`     | 获取可迁移的 session 列表 |


---



## 四、本地网关代理接口

> 以下接口用于代理底层 OpenCode 引擎和基座服务。


| 方法   | 路径                              | 说明                |
| ---- | ------------------------------- | ----------------- |
| GET  | `/opencode/getEnvironment`      | 获取环境信息            |
| GET  | `/weclawCli/getUserInfo`        | 获取用户信息            |
| GET  | `/opencode/*`                   | 透传到基座 OpenCode 服务 |
| GET  | `/weclawCli/*`                  | 透传到 WeClaw CLI 服务 |
| POST | `/opencode/fetchWebPageContent` | 抓取网页内容            |
| POST | `/opencode/checkFileIsKia`      | KIA 文档校验          |
| POST | `/opencode/exportPptDeck`       | PPT 导出            |


---



## 五、健康检查与其他


| 方法   | 路径                                     | 说明              |
| ---- | -------------------------------------- | --------------- |
| GET  | `/v1/health`                           | 健康检查            |
| PUT  | `/v1/assistant-persona/persona`        | 更新助手人设          |
| POST | `/v1/workspace/ensure-personas`        | 确保人设工作区         |
| GET  | `/v1/opencode/tool`                    | 获取 session 工具列表 |
| POST | `/v1/opencode/session/question/reject` | 拒绝 Agent 反问     |




### 健康检查详情

```
GET /v1/health
```

**响应** `200 OK`

```json
{
  "status": "ok",
  "service": "agent-bridge",
  "env": "production",
  "lang": "zh-CN",
  "userId": "u_xxx",
  "uuid": "uuid_xxx"
}
```

---



## 六、错误处理



### 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "code": "ERROR_CODE",
  "message": "错误描述信息"
}
```



### 常见错误码


| HTTP 状态码 | 错误码                   | 说明                         |
| -------- | --------------------- | -------------------------- |
| 400      | `VALIDATION_ERROR`    | 请求参数验证失败                   |
| 404      | `NOT_FOUND`           | 资源不存在（如 Agent/Session 不存在） |
| 404      | `NO_ACTIVE_CHAT`      | 没有正在执行的聊天                  |
| 500      | `INTERNAL_ERROR`      | 服务器内部错误                    |
| 502      | `BAD_GATEWAY`         | 上游引擎（OpenCode）调用失败         |
| 503      | `SERVICE_UNAVAILABLE` | 服务暂不可用（OpenCode 尚未就绪）      |


---



## 七、SSE 事件类型参考

> 所有事件通过 `GET /v1/events` 推送，格式为 BridgeEvent 信封。



### 连接事件


| 事件类型               | 说明           |
| ------------------ | ------------ |
| `server.connected` | SSE 连接建立成功   |
| `server.heartbeat` | 心跳事件（每 15 秒） |




### 会话状态事件


| 事件类型             | 说明       | properties 关键字段                            |
| ---------------- | -------- | ------------------------------------------ |
| `session.status` | 会话状态变更   | `sessionID`, `status.type`（`idle`/`busy`）  |
| `session.idle`   | 会话进入空闲状态 | `sessionID`                                |
| `session.error`  | 会话发生错误   | `sessionID`, `error.message`, `error.data` |




### 消息事件


| 事件类型                   | 说明     | properties 关键字段                  |
| ---------------------- | ------ | -------------------------------- |
| `message.part.updated` | 消息部分更新 | `sessionID`, `messageID`, `part` |


`message.part.updated` **中** `part` **类型说明**:


| part.type     | 说明          | 关键字段                                                            |
| ------------- | ----------- | --------------------------------------------------------------- |
| `text`        | 文本内容        | `content`                                                       |
| `tool`        | 工具调用        | `tool`（工具名）、`state.status`（`running`/`completed`）、`state.title` |
| `step-finish` | LLM step 结束 | 无额外字段                                                           |




### 交互事件


| 事件类型               | 说明         | properties 关键字段                                             |
| ------------------ | ---------- | ----------------------------------------------------------- |
| `question.asked`   | Agent 提出反问 | `sessionID`, `id`（requestID）, `questions[]`                 |
| `permission.asked` | Agent 请求权限 | `sessionID`, `id`（permissionID）, `permission`, `patterns[]` |




### 桥接事件


| 事件类型                    | 说明         | properties 关键字段                         |
| ----------------------- | ---------- | --------------------------------------- |
| `bridge.chat.started`   | 聊天开始       | `timestamp`, `observationUserInputText` |
| `bridge.chat.cleared`   | 聊天被清空      | `timestamp`                             |
| `bridge.config.updated` | 配置已更新      | —                                       |
| `bridge.queue.updated`  | 队列状态更新     | —                                       |
| `bridge.agent.created`  | Agent 创建完成 | `agent_id`                              |


---



## 八、评测完整交互流程

```
评测脚本                        网关 (:3008)                   OpenCode (:3009)
  |                                |                              |
  |-- POST /v1/agents ------------>|-- 创建 Agent ------------->  |
  |<-- {agent_id} ----------------|                              |
  |                                |                              |
  |-- GET /v1/events (SSE) ------>|                              |
  |<-- : bridge ------------------|                              |
  |                                |                              |
  |-- POST /v1/agents/:id/chat -->|-- 转发到 OpenCode ---------> |
  |                                |                              |
  |<-- session.status busy --------|<-----------------------------|
  |<-- message.part.updated (text)|<-----------------------------|
  |<-- permission.asked ----------|<-----------------------------|
  |                                |                              |
  |-- POST .../permission/respond->|---- 回复权限 -------------> |
  |                                |                              |
  |<-- message.part.updated (tool)|<-----------------------------|
  |<-- message.part.updated (text)|<-----------------------------|
  |<-- session.status idle -------|<-----------------------------|
  |                                |                              |
  |<-- chat 响应返回 --------------|                              |
  |                                |                              |
  |-- GET .../session/:id/message->|---- 获取消息快照 ----------> |
  |<-- [messages] ----------------|                              |
  |                                |                              |
  |-- DELETE /v1/agents/:id ----->|---- 删除 Agent ------------>|
  |<-- {ok: true} ----------------|                              |
```



### 判断本轮完成的规则

1. **SSE 事件判断**（推荐）:
  - 收到 `session.status` 且 `status.type` 为 `idle`
  - 或收到 `session.idle` 事件
  - 或收到 `session.error` 事件
2. **轮询兜底**:
  - 调用 `GET /v1/config/opencode/session/:id/message` 检查最后一条消息
3. **最终消息检查**:
  - 最后一条消息的 `role` 为 `assistant`
  - `info.finish` 为 `stop`（不是 `tool-calls`）
  - `parts` 数组包含 `step-finish` 类型

