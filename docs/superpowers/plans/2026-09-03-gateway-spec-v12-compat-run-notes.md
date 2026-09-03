# 通用规范 1.2 兼容实测执行笔记（gateway-spec-v12-compat / Task 3）

> 记录「会话创建兼容（title 可选、directory 从 body 读取）」与「OpenCode 引擎目录作用域」两项改造的回归与冒烟情况。
> 本机环境：macOS（arm64），Node v24.14.0，分支 `feature/spec-v12-compat`，基线 head `dda768d`。
> 无 key 部分由子代理真实执行（见 §1）；真实 key 双目录隔离冒烟按分工由控制器持有 key 执行（见 §2，PENDING）。

## 1. 无 key 验证（子代理执行）

### 1.1 全量测试套件（验证门）

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /Users/lzzd/project/Multi-AgentEngine-Gateway/bridge && node --test
```

结果：**153 pass / 0 fail / 0 skipped**（tests 153，duration ≈ 3.1s），退出码 0。含本特性新增的
`session create: body directory wins over query, query still works without body` 与 opencode 引擎目录作用域
（映射/请求注入/SSE 按目录分路）相关用例，基线 153/153 保持全绿、无回归。

### 1.2 无 key 网关冒烟（默认发现配置启动，占位 key，模型不会被调用）

```bash
mkdir -p /tmp/v12-smoke
ZAI_API_KEY=x node bridge/src/gateway/main.js --engine opencode --port 6219 &   # 后台，记录 PID
```

启动后 ~1s stderr 出现监听行（`gateway listening on http://localhost:6219 engine=opencode`）。
另有一条非阻塞配置告警：`mcp.welink-msg.env.WELINK_TOKEN references unset environment variable WELINK_TOKEN; the literal reference was kept`
（本机未设置该 MCP 环境变量，按既有设计保留字面引用，不影响本冒烟）。

**POST /session（无 title，directory 从 body 传入）：**

```bash
curl -s -X POST localhost:6219/session -H 'Content-Type: application/json' -d '{"directory":"/tmp/v12-smoke"}'
```

实测响应（HTTP **200**）：

```json
{"id":"ses_f98e5de29ffeAul7ex4CF7upjo","title":"会话-20260903-114920","created_at":"2026-09-03T11:49:20.986Z","status":"idle"}
```

断言核对：

- ✅ HTTP 200
- ✅ `id` 存在（`ses_…` 形态）
- ✅ `title` 形如 `会话-…`（服务端默认标题生成，请求未带 title 也不报错）
- ✅ `status` 为 `idle`

**GET /session/status（会话被注册且可见）：**

```bash
curl -s localhost:6219/session/status
# {"ses_f98e5de29ffeAul7ex4CF7upjo":{"type":"idle"}}   (HTTP 200)
```

**GET /session/{id}（空会话结构）：**

```bash
curl -s localhost:6219/session/ses_f98e5de29ffeAul7ex4CF7upjo
# {"id":"ses_f98e5de29ffeAul7ex4CF7upjo","title":"会话-20260903-114920","created_at":"2026-09-03T11:49:20.986Z","status":"idle","message_count":0}   (HTTP 200)
```

✅ `message_count` 为 0，与新建空会话一致。

### 1.3 收尾清理

`kill <PID>` 后 `pgrep -f "gateway/main.js"` 为空（启动前亦确认无残留进程，PID 干净退出）；
已删除 `~/.multi-agentengine-gateway/`、`/tmp/v12-smoke`、`/tmp/v12-smoke-gw.log`，环境恢复原状。

说明：directory 的请求注入/SSE 分路发生在引擎转发层（`?directory=<encodeURIComponent(path.resolve(dir))>`），
无 key 冒烟仅覆盖会话注册面（创建/查询），不触发模型调用；注入与双目录隔离的端到端行为由 §2 真实 key 冒烟覆盖。

## 2. PENDING：真实 key 双目录隔离冒烟（控制器执行）

以下为任务简报中 Step 2 的原始命令，需控制器持有真实 key 执行，子代理不接触 key：

```bash
export ZAI_API_KEY=<控制器持有>
mkdir -p /tmp/v12-dirA /tmp/v12-dirB
node bridge/src/gateway/main.js --engine opencode --port 6217 &
# 经网关（非裸 opencode API）：
# 1) POST /session {"directory":"/tmp/v12-dirA"}（无 title）→ 记 id
# 2) SSE 后台收流；POST prompt_async "在当前工作目录创建 a.txt 内容 ok"
# 3) 等 SSE session.idle；断言 /tmp/v12-dirA/a.txt 存在、SSE 收到 message.part.updated
# 4) 同法第二会话绑 /tmp/v12-dirB → b.txt 落 dirB；两目录互不串扰
# 5) rehearsal（默认目录）10/10 回归
```

执行完成后请在本节回填实测结果（各步断言输出、rehearsal 计数）。
