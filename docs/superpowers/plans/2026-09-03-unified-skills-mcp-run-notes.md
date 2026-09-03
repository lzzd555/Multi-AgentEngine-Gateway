# 网关统一能力供给实测执行笔记（unified-skills-mcp / Task 5）

> 记录 skills/mcp 统一能力供给特性（Task 1-4，commit a6ad707..55f5daa）的实测情况：本机（macOS 开发机，Node v24.14.0，**无 `ZAI_API_KEY` 环境**）完成了全量测试套件与三引擎真实启动的无 key 供给验证（生成/同步文件逐项核验、PI 本地二进制实证）；**真实 key 的三引擎 rehearsal 与 skill/MCP 对话验证待执行**（步骤与预期见 §3）。
> 配置 schema、三引擎映射与复制语义见 `solution/config-templates/README.md` 的「能力供给（skills / mcp，可选）」一节。

## 1. 全量测试套件（验证门）

```bash
cd bridge && node --test
```

结果：**128 tests, 128 pass, 0 fail**（含 skills/mcp schema 校验、三引擎 skills 复制/幂等重同步、OpenCode mcp 段合并、OMP/PI mcp.json 生成、PI settings.json extensions 合并语义、PI 启动命令本地优先矩阵、adapter 未装警告回落），duration ≈ 3.1s，退出码 0。

## 2. 三引擎无 key 冒烟（真实启动，逐项核验生成物）

配置即仓库根 `gateway.config.example.json` 新增的 `skills: ["./skills/demo-skill"]` + `mcp.fetch`（local `npx -y mcp-server-fetch`）两段，复制为仓库根临时副本 `skm-verify.config.json` 经 `--config` 指定（不污染用户本地 `gateway.config.json`；验证后已删除）。

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

## 3. PENDING：真实 key 三引擎 rehearsal + skill/MCP 对话验证（控制器执行）

前置：`export ZAI_API_KEY=<真实key>`（GLM Coding 订阅 key；example 配置即 coding 端点）。逐引擎起停，每引擎跑完 `kill` 再起下一个：

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$HOME/.local/bin:$PATH"
export ZAI_API_KEY=<用户环境提供>
cd /Users/lzzd/project/Multi-AgentEngine-Gateway
cp gateway.config.example.json skm-test.config.json   # 须放仓库根（skills 相对路径按配置文件所在目录解析），测后删除
# ① opencode
node bridge/src/gateway/main.js --config skm-test.config.json --engine opencode --port 6217 &
sleep 6 && curl -s http://localhost:6217/health && npm run rehearsal        # 预期 10/10
ls ~/.multi-agentengine-gateway/opencode/xdg/opencode/skills/               # 预期 demo-skill
kill %1
# ② omp：同上（--engine omp），另查 ~/.multi-agentengine-gateway/omp/agent/{skills,mcp.json}
# ③ pi：同上（--engine pi），另查 ~/.multi-agentengine-gateway/pi/agent/{skills,mcp.json,settings.json}
#     并 ps 确认子进程为 node_modules/.bin/pi-acp（本地）而非 npx
```

skill 生效对话探针（每引擎，经网关 HTTP）：

```bash
SID=$(curl -s -X POST http://localhost:6217/session -H 'Content-Type: application/json' \
  -d '{"title":"skill-probe"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
curl -s -X POST http://localhost:6217/session/$SID/prompt_async -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"请演示技能"}]}'   # 204；阻塞至本轮完成
curl -s http://localhost:6217/session/$SID/message | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).at(-1);console.log(m.role, m.info?.finish, JSON.stringify(m.parts).includes('demo-skill'))})"
# 预期：assistant stop true（回答含 demo-skill，来源为网关统一供给）
```

MCP 生效验证（每引擎任选其一）：对话中请求"用 fetch 工具获取 https://example.com 的标题"；或查 OpenCode 日志 / OMP 启动输出中 `mcp-server-fetch` 被拉起。

需要就此得出结论并**回填**的两个验证项（spec §5）：

1. **PI adapter 兼容性**（pi-mcp-adapter 2.32.1 × pi-acp 0.5.0 内嵌 pi 0.84.2）：pi 引擎 rehearsal 10/10 + fetch 工具实际可调 → 兼容结论回填本笔记与 config-templates/README；不兼容则 `npm view pi-mcp-adapter versions` 选与 0.84.2 同期版本 pin 进 `package.json` optionalDependencies，并回填设计文档 §4。
2. **OMP remote 形态**：skm-test.config.json 的 mcp 段临时追加 `"context7": {"type": "remote", "url": "https://mcp.context7.com/mcp"}` 后 `--engine omp` 启动，确认 OMP 18.1.2 是否接受生成的 `{"type":"http",...}` 形态；不支持则按 spec §5 降级为"启动警告并忽略"并回填 config-templates/README 的状态标注。

结果记录位置：本笔记新增 §4（或控制器回填表格）；遗留问题一并列出。

## 4. 遇到的问题

- （无 key 阶段）无异常：套件全绿；三引擎真实启动一次通过，生成文件逐项符合预期；未设 key 告警按设计出现。
- 发现并记录的坑：skills 相对路径相对配置文件所在目录解析，配置副本放 `/tmp` 会因解析到 `/tmp/skills/...` 而启动报错——已在 §2 如实标注，§3 命令已按仓库根副本给出。
- OpenCode 会在重定向后的 XDG 配置目录里自动安装 `@ai-sdk/openai-compatible`（provider 的 `npm` 字段）到该目录 `node_modules/`——属 OpenCode 原生行为，文件落在隔离目录内、不污染用户 `~/.config/opencode/`，无需处理。
