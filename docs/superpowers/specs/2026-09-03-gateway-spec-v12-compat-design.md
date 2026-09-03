# 网关接口规范（通用版 1.2）兼容改造设计

- 日期：2026-09-03
- 状态：设计中已评审（对话内完成方案权衡与实测验证；范围 ①②，③ 经实测确认已达标划掉，④ 部署侧暂缓）
- 需求来源：赛题规范更新——《技术难题-多agent引擎可替换架构实现-任务书-1.1.md》《网关接口规范_通用-1.2.md》《调测指南-1.1.md》；任务书明确"两个网关规范实现任意一个即可"，本设计使网关同时满足旧规范与新通用规范
- 前置：统一配置（2026-09-02）与能力供给（2026-09-03）两期特性已在 main

## 1. 背景与差距分析

对照《网关接口规范_通用-1.2》逐条核查现有实现（147 测试基线）：

| 项 | 现状 | 差距 |
|---|---|---|
| §3.1 `title` 可选（"实际系统不传入会默认生成"） | 缺失即 400 拒绝 | **必须改为可选** |
| §3.1 `directory` 必选支持（body 内，"评测需要指定目录"） | 从 URL query 读取，body 内被忽略 | **必须从 body 读取** |
| §3.1 响应 `{id, title, created_at, status:"idle"}` | registry 已返回该形状 | 无 |
| §3.2 `GET /session/{id}`（含 message_count） | 已实现 | 无 |
| §4.1 prompt 的 `model{providerID,modelID}` 必填语义 | 已解析使用（缺省回落 defaultModel） | 无 |
| §4.2 消息轨迹（content/tool_calls/tool 消息） | 已实现（曾误判缺失，实测完整） | 无 |
| §4.3 abort + stop 别名 | 已实现 | 无 |
| §5 question/permission（可选） | 全量实现 | 无 |
| §6 SSE 全事件 | 已实现（默认目录作用域） | 目录作用域会话的事件需分路订阅（见 §3） |
| 附录 B "支持 directory 参数实现项目隔离" | ACP 引擎（OMP/PI）经 session/new cwd 生效；**OpenCode 引擎忽略** | **必须实现** |
| 调测指南：主模型限定内部部署模型 | 统一配置支持任意 OpenAI 兼容 baseUrl | 部署侧事项，暂缓（④） |

## 2. 调研结论（OpenCode 1.18.26 目录机制，实测确认）

- `POST /session` 的 **`?directory=` 查询参数**是会话级目录绑定机制：会话 `directory` 真实指向目标目录（非 git 目录归 `projectID: "global"` 项目），assistant 消息的 `path.cwd` 即绑定目录，**文件操作真实落在绑定目录**（实测：会话绑定 `/tmp/oc-dir-a` 后创建文件成功落于该目录，模型报告 pwd 一致）
- body 内 `directory` 字段被忽略（schema `additionalProperties:false`，无此字段）；`attach --dir` 是 TUI 客户端同一目录体系的 CLI 入口
- `move-session` 仅支持同项目已知目录（跨项目报 "Destination directory belongs to another project"），不通用
- 单 serve 实例即可服务多目录会话，**无需按目录托管多个 host**（原 host 池方案否决）
- **事件流按作用域隔离**：无作用域 `/event` 收不到目录作用域会话的事件，必须订阅 `/event?directory=<dir>`
- 数据端点（message/status）无作用域也能命中目录作用域会话，但统一带 `?directory=` 保证一致性
- 坑位记录：opencode 的 `prompt_async` HTTP 层**立即返回 204**（异步语义），回合完成需另行判定——网关引擎层的轮询等待逻辑已正确处理，裸调验证时需等 idle

## 3. 设计

### 3.1 POST /session 兼容（`gateway-server.js`）

- `title` 可选：`body.title` 非非空字符串时自动生成 `会话-<yyyyMMdd-HHmmss>`，响应回填生成值；不再 400
- `directory`：`body.directory`（非空字符串）优先，`url.searchParams.get("directory")` 保留为兼容回落；透传 `engine.createSession`
- 响应形状不变（registry 现返回 `{id, title, created_at, status:"idle"}`）

### 3.2 OpenCode 引擎目录作用域（`opencode-engine.js`）

- 引擎维护 `sessionDirectories: Map<sessionID, absDirectory>`（`path.resolve` 归一）
- `createSession({title, directory})`：directory 非空 → `POST /session?directory=<encodeURIComponent(abs)>` 并记录映射；为空走现状
- 会话级请求（prompt_async、abort、message）经统一请求辅助注入 `?directory=<映射值>`；无映射不注入。全局 `/session/status` 轮询保持无作用域（实测可命中目录作用域会话的状态，不改动）（修订：实测发现目录会话 busy 态仅作用域可见，waitUntilIdle 已改按映射作用域轮询、listSessionStatuses 聚合——见 run-notes §2.1，commit e964723）
- **SSE 按目录分路**：引擎现有的无作用域 `/event` 订阅保持（服务默认会话）；首次为某目录创建会话时额外建立 `/event?directory=<dir>` 订阅，SSE 事件解析与过滤逻辑与现有一致，事件并入同一 emit 分发；同目录多会话共享一条订阅（`Map<dir, controller>`）；`dispose()` 时全部 abort
- OMP/PI 引擎不动（ACP `session/new` 的 cwd 已正确实现目录隔离）

### 3.3 数据流示例

评测创建 `{"directory": "D:\\workspace\\task1"}`（无 title）→ 网关生成标题、OpenCode 引擎经 `POST /session?directory=D:/workspace/task1` 绑定 → prompt 经 `?directory=` 路由 → 工具文件操作落在 task1 目录 → SSE 事件经该目录的分路订阅推送网关 `/event` → 裁判按 finish=stop + step-finish 判定。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| body/query 均无 directory | 走默认目录（现状），零行为变化 |
| directory 指向不存在目录 | 由 opencode 会话创建报错，引擎按 ENGINE_UNAVAILABLE/INTERNAL_ERROR 上抛（不预检存在性——评测环境目录由评测方保证创建） |
| 目录作用域 SSE 连接断开 | 与现有默认订阅同策略（引擎现有重连/容错逻辑沿用） |
| 同目录并发首会话 | Map 幂等，仅建一条订阅 |

## 5. 测试

- 网关层：无 title 创建成功且响应含生成标题与 status/created_at；body 与 query 两种 directory 传法均透传；title+directory 组合
- 引擎层（mock fetch/SSE）：createSession 注入 directory 查询参数；sessionDirectories 映射与会话级请求注入；目录 SSE 订阅建立/共享/清理（dispose 全 abort）；无 directory 会话不建订阅
- 回归：147 现有测试全绿；rehearsal 10/10（默认目录路径）
- 实测冒烟：真实网关 + 目录作用域会话（绑定临时目录 → prompt 创建文件 → 文件落于绑定目录 → SSE 事件经网关可收）；无 key 结构验证由子代理执行，真实 LLM 验证由控制器执行

## 6. 非目标

- ④ 内部部署模型端点/鉴权适配（暂缓，等内部端点信息；统一配置 baseUrl 已可切换）
- OpenCode 引擎跨引擎会话同步、持久化（任务书可选不实现项，维持）
- `move-session` / workspace 等 opencode 实验特性
- 修改 OMP/PI 引擎目录行为
