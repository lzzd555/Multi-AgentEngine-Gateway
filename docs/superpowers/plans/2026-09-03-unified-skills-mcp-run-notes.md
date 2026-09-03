# 网关统一能力供给实测执行笔记（unified-skills-mcp / Task 5）

> 记录 skills/mcp 统一能力供给特性（Task 1-4，commit a6ad707..55f5daa）的实测情况：本机（macOS 开发机，Node v24.14.0）先完成了全量测试套件与三引擎真实启动的无 key 供给验证（生成/同步文件逐项核验、PI 本地二进制实证）；**真实 key 的三引擎 rehearsal 与 skill/MCP 对话验证已于 2026-09-03 由控制器完成（结果总表与调试叙事见 §3）**，过程中发现并修复两处问题——OMP MCP 改经 ACP `session/new.mcpServers` 传递、pi 子进程注入 TLS 兼容 shim（代码修复落盘 commit 71e8be6，设计侧结论见设计文档 §10 实施后记）。
> 配置 schema、三引擎映射与复制语义见 `solution/config-templates/README.md` 的「能力供给（skills / mcp，可选）」一节。

## 1. 全量测试套件（验证门）

```bash
cd bridge && node --test
```

结果：**128 tests, 128 pass, 0 fail**（含 skills/mcp schema 校验、三引擎 skills 复制/幂等重同步、OpenCode mcp 段合并、OMP/PI mcp.json 生成、PI settings.json extensions 合并语义、PI 启动命令本地优先矩阵、adapter 未装警告回落），duration ≈ 3.1s，退出码 0。

## 2. 三引擎无 key 冒烟（真实启动，逐项核验生成物）

配置即仓库根 `gateway.config.example.json` 新增的 `skills: ["./skills/demo-skill"]` + `mcp.fetch`（local `npx -y mcp-server-fetch`）两段，复制为仓库根临时副本 `skm-verify.config.json` 经 `--config` 指定（不污染用户本地 `gateway.config.json`；验证后已删除）。注：`mcp-server-fetch` 后经实测确认为 npm 上的 0.0.1-security 占位包，示例已改用 `@modelcontextprotocol/server-memory`（见 §3 与设计文档实施后记 d）。

**注意（对 §3 执行者同样适用）**：skills 相对路径相对**配置文件所在目录**解析——配置副本放 `/tmp` 会在启动时报 `skills entry './skills/demo-skill' not found: /tmp/skills/demo-skill`（行为符合设计），故副本必须与 `skills/` 同级（仓库根，即文档推荐的复制位置）。

各引擎真实拉起（`node bridge/src/gateway/main.js --config skm-verify.config.json --engine <id> --port 6217 &`），`GET /health` 均 `{"ok":true}`；stderr 均先出现**未设 key 告警**（本次验证的预期项）再出现监听行：

```
gateway config warning: model.providers.zaicoding.apiKey references unset environment variable ZAI_API_KEY; the engine will fail auth until it is set
gateway listening on http://localhost:6217 engine=<id>
```

| 引擎 | 生成/同步文件核验 | 注入实证（ps） |
| --- | --- | --- |
| opencode | `~/.multi-agentengine-gateway/opencode/opencode.json` = provider 段 + `mcp.fetch = {"type":"local","command":["npx","-y","mcp-server-fetch"]}` **并入同一文件**；`opencode/xdg/opencode/skills/demo-skill/{SKILL.md,reference.md}` 整目录复制（`diff -r` 与源一致） | OpenCode 自身在重定向后的 XDG 配置目录里自动安装自定义 provider 包（`package.json`/`node_modules`/`.gitignore` 落在 `<state>/opencode/xdg/opencode/` 下）——`XDG_CONFIG_HOME` 注入生效的直接证据 |
| omp | `<state>/omp/agent/mcp.json` = `{"mcpServers":{"fetch":{"command":"npx","args":["-y","mcp-server-fetch"]}}}`（command 数组按 OMP 形态拆分）；`agent/skills/demo-skill/` 整目录复制（一致）；`agent/models.yml` 同前特性不变 | omp 子进程 env 含 `PI_CONFIG_DIR=.multi-agentengine-gateway/omp`（ps 实证）；OMP 自身 `agent.db`/`models.db`/`logs/` 写入隔离根 |
| pi | `<state>/pi/agent/mcp.json`（同 OMP 的 mcpServers 形态）；`agent/settings.json` = `{"extensions":["<repoRoot>/node_modules/pi-mcp-adapter/index.ts"]}`（经包 manifest `exports` 解析的入口，文件真实存在）；`agent/skills/demo-skill/` 整目录复制（一致）；`agent/models.json` 同前特性不变 | **pi 子进程命令为 `node <repoRoot>/node_modules/.bin/pi-acp`（本地 node_modules 二进制，非 npx，ps 实证）**；env 含 `PI_CODING_AGENT_DIR=<state>/pi/agent`；PI 自身 `auth.json`/`models-store.json` 写入隔离 agent 目录 |

**PI adapter 无 key 兼容性信号**：pi-acp 0.5.0 携带 settings.json 中的 adapter 入口（pi-mcp-adapter 2.32.1 的 `index.ts`）正常启动——ACP initialize 成功、网关正常监听、无 stderr 报错，说明入口本身被 PI 运行时接受加载；MCP server 的实际拉起与工具调用（真正的兼容性结论，含是否需 pin 旧版 adapter）仍待 §3 真实 key rehearsal 确认。

**清理**：验证完成后 `rm -rf ~/.multi-agentengine-gateway` 与临时配置副本；无残留网关/引擎进程，端口 6217 释放。用户本地 `gateway.config.json` 未被触碰（如需启用能力供给，可自行把 example 中 `skills`/`mcp` 两段抄入——相对路径以该文件所在目录解析）。

## 3. 真实 key 三引擎 rehearsal + skill/MCP 对话验证（控制器执行，2026-09-03 完成）

按原计划执行（`ZAI_API_KEY` 真实 key、配置副本放仓库根、逐引擎起停、skill 对话探针 + MCP 工具验证）；过程中发现的两处问题（OMP MCP 通道、api.z.ai TLS）经修复落盘 commit 71e8be6 后复测收尾。MCP server 组合：`@modelcontextprotocol/server-memory`（local，npx 拉起）+ `context7`（remote `https://mcp.context7.com/mcp`，验证 remote 形态）——原计划示例包 `mcp-server-fetch` 为 npm 上的 0.0.1-security 占位包（官方 fetch server 已从 npm 下架、仅存 Python 形态），已换用官方维护的 memory server（设计文档实施后记 d）。

### 3.1 结果总表

| 引擎 | rehearsal | skill 验证 | MCP 验证 | 备注 |
| --- | --- | --- | --- | --- |
| OpenCode 1.18.26 | 10/10 | ✓ 模型经原生 skill 工具发现 demo-skill 并复述正文 | ✓ memory 9 工具上线（生成文件 mcp 段） | — |
| OMP 18.1.2 | 10/10 | ✓ skill://demo-skill 挂载并复述 | ✓ remote context7 两工具（session/new.mcpServers）；memory 因 250ms 竞速窗口未挂载（omp 18.1.2 已知回归，18.1.3+ 已修；本机升级因 GitHub CDN 超时未完成） | 权限挂起-应答闭环正常 |
| PI（本地 pi-acp 0.5.0） | 10/10（TLS shim 后） | ✓ 发现 skill 并报出隔离目录路径 | ✓ adapter 装配：memory 10 工具 + context7 remote 2 工具全部连接并缓存 | 首轮 7/10 系平台 TLS 故障（见实施后记），shim 后全绿 |

### 3.2 调试叙事：PI 首轮 7/10 → TLS shim 后 10/10

PI 首轮 rehearsal 7/10，失败项全部是模型调用超时。排查链：PI journal 中失败轮次均为 **"Request timed out"** → 换 provider（内置 `zai/glm-4.7`）与配置的 `zaicoding/glm-5.2` 均同样失败，排除 provider/model 配置问题 → 同机 `curl` 同端点正常而 Node fetch 报 `UND_ERR_CONNECT_TIMEOUT`，指向 Node 网络栈差异 → 裸 `tls.connect` 对 api.z.ai 挂起；限定 `ecdhCurve: "X25519:P-256:P-384"` 后 **316ms** 内完成握手 → 结论：2026-09-03 api.z.ai 平台升级（glm-5.3 上线）后的新 CDN **丢弃携带 MLKEM768 大 ClientHello 的 TLS 握手**（Node 24/OpenSSL 3.5 默认发送；curl/Bun 不发送——故 OMP/OpenCode 无恙而纯 Node 子进程的 PI 全挂）→ 修复：`bridge/src/tls-compat-shim.cjs` 经 `NODE_OPTIONS --require` 注入 pi 子进程、限定经典曲线组（叠加不覆盖既有 NODE_OPTIONS，仅统一配置路径生效）→ 复测 **10/10**。平台修复后 shim 冗余但无害（设计文档实施后记 b）。

### 3.3 调试叙事：OMP mcp.json 无效 → ACP `session/new.mcpServers` 通道

OMP 侧 skill（skill://demo-skill 挂载复述）与 rehearsal 均正常，但按原设计生成的 `<state>/omp/agent/mcp.json` 中 MCP server 始终不上线。追查上游源码：omp 的 ACP 模式以 `enableMCP:false` **禁用磁盘 mcp.json 发现**（上游 main.ts 注释与 issue #1234）——该文件只对 TUI 模式 omp 有效。纠正为网关作为 ACP 客户端经 `session/new.mcpServers`（及 session/load、session/resume）传递 @agentclientprotocol/sdk v1 形态（stdio `{name, command, args, env: Array<{name,value}>}`、http `{name, type:"http", url, headers: Array<{name,value}>}`；PI 不经此通道，避免与 pi-mcp-adapter 双重挂载）。实测 remote（context7）两工具上线；慢启动 stdio（npx 冷启的 memory）在 18.1.2 上仍不挂载——系 omp 18.1.2 的 **250ms MCP 启动竞速窗口**（上游 18.1.3+ 已修，本机升级因 GitHub CDN 超时未完成），非网关问题。

### 3.4 两个验证项的回填结论

1. **PI adapter 兼容性**（pi-mcp-adapter 2.32.1 × pi-acp 0.5.0 内嵌 pi 0.84.2）：**兼容**——memory + context7 remote 全部连接成功并缓存，无需 pin 旧版。已回填设计文档 §4/§5/§10 与 config-templates/README。
2. **OMP remote 形态**：**接受**——经 ACP `mcpServers` 的 `{"type":"http",...}` 形态 context7 两工具上线，无需降级为"警告并忽略"。已回填设计文档 §5/§6/§10 与 config-templates/README。

修复落盘（commit 71e8be6）后全量测试套件：**135 tests, 135 pass, 0 fail**（本 docs 回填 wave 复跑一次确认同样全绿）。

## 4. 遇到的问题

- （无 key 阶段）无异常：套件全绿；三引擎真实启动一次通过，生成文件逐项符合预期；未设 key 告警按设计出现。
- 发现并记录的坑：skills 相对路径相对配置文件所在目录解析，配置副本放 `/tmp` 会因解析到 `/tmp/skills/...` 而启动报错——已在 §2 如实标注（复现时配置副本须放仓库根）。
- OpenCode 会在重定向后的 XDG 配置目录里自动安装 `@ai-sdk/openai-compatible`（provider 的 `npm` 字段）到该目录 `node_modules/`——属 OpenCode 原生行为，文件落在隔离目录内、不污染用户 `~/.config/opencode/`，无需处理。
- （真实 key 阶段）两处问题：① api.z.ai 平台升级后 CDN 丢弃 MLKEM768 大 ClientHello 的握手（PI 全挂，TLS shim 处置）；② omp ACP 模式不读磁盘 mcp.json（改经 `session/new.mcpServers` 传递）；另有 omp 18.1.2 的 250ms MCP 启动竞速窗口（上游已修）。详见 §3.2/§3.3 与设计文档 §10 实施后记。
