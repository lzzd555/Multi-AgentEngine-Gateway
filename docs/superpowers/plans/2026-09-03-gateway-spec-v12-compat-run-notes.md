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

## 2. 真实 key 双目录隔离冒烟（控制器执行，2026-09-03 完成）

### 2.1 首轮发现缺陷（已修复）

首轮冒烟暴露一个隐蔽缺陷：目录作用域会话的 **busy 态只出现在 `/session/status?directory=` 作用域查询中**（无作用域 status 恒显 idle——规格 §3.2 的"实测可命中"假设只对 idle 成立）。后果：`waitUntilIdle` 无作用域轮询 2 秒宽限后假完成 → `prompt_async` 提前 204（实测 2.08s 即返回，而回合仍在后台执行，文件数十秒后才落地）。修复（commit `e964723`）：`waitUntilIdle` 对映射会话轮询作用域 status（`statusPath` 辅助）；`listSessionStatuses` 聚合无作用域 + 各目录作用域结果（作用域值优先），网关 `GET /session/status` 对目录会话不再误报 idle。实证：修复后真实回合期间作用域 status 持续 busy 18+ 次轮询、无作用域恒 idle。

### 2.2 修复后复验（全部通过）

| 验证项 | 结果 |
|---|---|
| 会话 A（dirA，无 title，三步建文件任务） | ✅ prompt **真实阻塞 13.0s** 至回合完成（不再 2 秒假返回），a1/a2/a3.txt 即时落 `/tmp/v12-dirA` |
| 会话 B（dirB，两步建文件任务） | ✅ b1/b2.txt 落 `/tmp/v12-dirB`；轨迹完整（write×2 → 工具结果 → 总结文本） |
| busy 聚合 | ✅ B 回合进行中网关 `GET /session/status` 正确显示 `busy`（修复前会误显 idle） |
| 目录隔离 | ✅ dirA 仅 a1-a3、dirB 仅 b1-b2，互不串扰 |
| SSE 分路 | ✅ 两会话事件均经网关 `/event` 正常推送（message.part.updated/session.idle） |
| rehearsal 回归（默认目录） | ✅ **10/10**（6.6s） |
| title 自动生成（真 key 环境） | ✅ `会话-<yyyyMMdd-HHmmss>` 形态回填 |

测试套件随修复 153 → **155**（新增作用域轮询等待与状态聚合用例），全绿。
