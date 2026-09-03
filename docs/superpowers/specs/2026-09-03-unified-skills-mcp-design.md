# 网关统一能力供给设计（Skills + MCP）

- 日期：2026-09-03
- 状态：已评审通过（范围 Skills+MCP、来源=路径引用、实现=扩展现有 provision 机制；修订：PI 本地化安装 + PI MCP 经本地 adapter 完整支持）
- 需求来源：用户需求——在 `gateway.config.json` 一处声明 skill 与 MCP server，网关 provision 时自动同步到所选引擎，无需逐引擎配置；PI 及其 MCP 拓展直接装进项目代码
- 前置设计：`2026-09-02-unified-gateway-config-design.md`（本设计建立在其隔离注入机制之上，分支堆叠于 feature/unified-gateway-config）

## 1. 背景与目标

统一配置已覆盖模型与引擎位置，但 skill/MCP 仍需逐引擎手工配置；且隔离注入使各引擎用户目录（`~/.omp`、`~/.pi`、`~/.config/opencode`）里已装的 skill 被绕开。目标：配置文件新增 `skills` / `mcp` 两段，provision 时把能力同步到**所选引擎正在读取的隔离位置**——引擎按各自原生机制发现，网关不做任何引擎改造。

### 调研结论（机制矩阵，源码/文档确认）

| 能力 | OpenCode 1.18.26 | OMP 18.1.2 | PI（pi-acp 0.5.0 内嵌 pi 0.84.2） |
|---|---|---|---|
| Skills | 全局 `~/.config/opencode/skills/<name>/SKILL.md`（经 `XDG_CONFIG_HOME` 可重定向）；frontmatter `name`（1-64，小写字母数字连字符，须与目录名一致）/`description`（1-1024）必填 | `<OMP 根>/agent/skills/<name>/SKILL.md`，仅一级目录（嵌套被忽略）；`description` 对原生 provider 必填（frontmatter 解析由引擎完成，网关不解析） | `<agentDir>/skills/<name>/SKILL.md`；`dist/core/resource-loader.js` 中 `join(this.agentDir, "skills")` 为发现根，目录含 SKILL.md 即技能根、递归发现 |
| MCP | 生成文件 `mcp.<name>` 字段：`{ "type": "local", "command": ["…"], "environment": {} }` 或 `{ "type": "remote", "url": "https://…", "headers": {} }`（官方 config schema） | 用户级 `~/.omp/agent/mcp.json`（`docs/mcp-config.md`），标准 `mcpServers` 结构 | 本体无原生配置，经 `pi-mcp-adapter` 扩展装配；**adapter 尊重 `PI_CODING_AGENT_DIR`**（官方文档：`$PI_CODING_AGENT_DIR/mcp.json` when set），隔离模式可用 |

关键事实：三引擎的 skill 发现根**都随既有隔离注入变量走**（OMP 随 `PI_CONFIG_DIR`、PI 随 `PI_CODING_AGENT_DIR`、OpenCode 全局 skills 随 `XDG_CONFIG_HOME`），因此 skills 供给只需"把文件写对位置"。

## 2. Schema 扩展

```json
{
  "model": { "…": "…" },
  "skills": [
    "./skills/git-release",
    "~/.shared-skills/pdf-export",
    "./legacy/solo/SKILL.md"
  ],
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "fetch": { "type": "local", "command": ["npx", "-y", "mcp-server-fetch"], "env": { "K": "V" } }
  },
  "engines": { "…": "…" }
}
```

- **skills**：字符串数组。每项为 skill 目录（内含 `SKILL.md`，可有伴随文件）或单个 `SKILL.md` 文件路径；支持 `~` 展开与相对路径（相对配置文件所在目录）。skill 名 = 目录名；直引文件时 = **其父目录名**（`./legacy/solo/SKILL.md` → `solo`；文件名本身固定为 SKILL.md，不可作为名字来源）。
- **mcp**：对象，key 为 server 名（`[a-z0-9-]+`）。两种形态：
  - `local`：`command`（完整命令数组，元素非空字符串）+ 可选 `env`（字符串键值对象）
  - `remote`：`url`（http(s)）+ 可选 `headers`（字符串键值对象）
- 两段均可选、可独立存在；未配置时 provision 行为零变化。
- **不做 per-engine 覆盖**（能力供给无引擎间差异需求）；**不做代码级 extension/plugin 投放**（三引擎 API 互不兼容，无统一抽象价值）。

### 校验（失败即启动报错退出，不生成任何文件，报错风格与现有校验一致——含文件路径）

- skills：路径存在；目录形态必须含 `SKILL.md`，文件形态文件名必须为 `SKILL.md`；推断出的 skill 名（目录名/父目录名）匹配 `[a-z0-9][a-z0-9-]*` 且在列表内唯一
- mcp：`type` ∈ {local, remote} 二选一；local 必须有非空 `command` 数组；remote 必须有 http(s) `url`；`env`/`headers` 必须为字符串键值对象
- SKILL.md 的 frontmatter 不解析、不校验、不改动——原样复制，由引擎按各自规则解析（frontmatter 规则三引擎有差异，网关不替引擎把关）

## 3. Skills 供给

provision 时**复制**（非符号链接）到所选引擎的 skills 目录，每次启动幂等重同步——按 skill 清理重建各自的目标目录（`<目标>/skills/<name>/`，非整棵 skills 根），源删除后目标不残留：

| 引擎 | 目标位置 | 机制 |
|---|---|---|
| OpenCode | `<stateDir>/opencode/xdg/opencode/skills/<name>/` | spawn env 注入 `XDG_CONFIG_HOME=<stateDir>/opencode/xdg`。**只重定向 `XDG_CONFIG_HOME`**，不动 `XDG_DATA_HOME`/`XDG_CACHE_HOME`——auth、数据、缓存不受影响。`OPENCODE_CONFIG`（provider 配置）与 `XDG_CONFIG_HOME`（skills 全局目录）叠加生效，互不冲突 |
| OMP | `<stateDir>/omp/agent/skills/<name>/` | 隔离根直写，随 `PI_CONFIG_DIR` 被 OMP 原生发现 |
| PI | `<stateDir>/pi/agent/skills/<name>/` | 隔离根直写，随 `PI_CODING_AGENT_DIR` 被 pi 原生发现 |

- 整目录复制：SKILL.md 的伴随文件（参考文件、脚本等）一并进入
- 目录名即 skill 名（OpenCode 要求 frontmatter name 与目录名一致——由 skill 作者保证；若不一致，OpenCode 侧该 skill 报错不影响其他 skill，OMP/PI 以 frontmatter/目录名各自容错）

## 4. PI 本地化安装（项目内置）

PI 是轻引擎，按用户决策**直接装进项目**，消除 npx 首跑网络拉取与 12 秒启动延迟：

- `package.json` 增加 `optionalDependencies`：`@automatalabs/pi-acp@0.5.0`（依赖树 268MB/139 包，node_modules 不入库，lockfile 锁定版本）与 `pi-mcp-adapter@2.32.1`（约 2.9MB）。用 `optionalDependencies` 而非 `dependencies`：离线/安装失败不阻断 `npm install`，网关按下面的优先级回落
- **PI 启动命令优先级**：配置 `engines.pi.command` > 项目本地 `<repoRoot>/node_modules/.bin/pi-acp` > PATH 上的 `pi-acp` > npx 拉起（现状兜底）。本地探测在网关侧 `resolveEngineCommand` 的默认解析链中实现（repoRoot 从 gateway-config.js 向上定位 package.json）；未改动 bridge 的 `resolveAcpLaunch`
- **代价（如实记录）**：交付流程从"无需 npm install"变为"建议 `npm install`（未装时 PI 回落 npx，OpenCode/OMP 不受影响）"。README/INSTRUCTION 同步更新。网关核心零依赖约束不受影响（import 边界测试只约束 gateway/ 核心文件，依赖声明在仓库根 package.json）
- **已验证（2026-09-03 实测，见 §5 PI 行与 §10 实施后记）**：pi-mcp-adapter 2.32.1 与 pi-acp 0.5.0 内嵌 pi 0.84.2 兼容，无需 pin 旧版

## 5. MCP 供给

| 引擎 | 机制 |
|---|---|
| OpenCode | 并入生成的 `opencode.json`：local → `mcp.<name> = { type: "local", command, environment: env }`；remote → `{ type: "remote", url, headers }`。与 provider 段同文件，无新增注入变量 |
| OMP | 网关作为 ACP 客户端经 `session/new.mcpServers`（及 `session/load`、`session/resume`）传递（@agentclientprotocol/sdk v1 形态：stdio `{name, command, args, env: Array<{name,value}>}`、http `{name, type:"http", url, headers: Array<{name,value}>}`）。依据：omp ACP 模式 `enableMCP:false` 禁用磁盘 mcp.json 发现（上游 main.ts 注释与 issue #1234）。`<stateDir>/omp/agent/mcp.json` 文件仍会生成——对 TUI 模式 omp 有效且无害（实测纠正见 §10 实施后记 a） |
| PI | 生成 `<stateDir>/pi/agent/mcp.json`（标准 `mcpServers` 结构，adapter 经 `PI_CODING_AGENT_DIR` 读取）；并在 `<stateDir>/pi/agent/settings.json` 的 `extensions` 数组写入本地 adapter 入口路径（**合并语义**：settings.json 已存在则读取-合并 extensions，绝不整体覆盖）。**前提**：本地 adapter 已安装（§4）；未安装时 stderr 警告"运行 npm install 启用 PI 的 MCP"并忽略 mcp 段，引擎正常启动。**已验证（2026-09-03 实测）**：pi-mcp-adapter@2.32.1 与内嵌 pi 0.84.2 兼容——memory 10 工具 + context7 remote 2 工具全部连接成功；settings.json extensions 指向 `node_modules/pi-mcp-adapter/index.ts`（包无 main/dist，TS 入口为 pi extension 惯例） |

统一 schema 的 `command` 为完整数组（OpenCode 原生形态）；OMP/PI 生成时拆分为 `command[0]` + `args`。`command`/`url`/`env` 值中的 `${VAR}` 等**不做展开**，原样透传（MCP server 的环境变量用显式 `env` 字段表达）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| skill 路径不存在 / 目录无 SKILL.md / 名字非法或重复 | 启动报错退出，不生成任何文件 |
| mcp 校验失败（type/command/url/env 形态） | 同上 |
| 目标 skills/mcp 目录不可写 | 启动报错退出 |
| OMP+remote MCP 实测不支持 | （预留降级分支，实测未触发：OMP 18.1.2 经 ACP `mcpServers` 接受 http 形态，context7 两工具上线） |
| PI + mcp 段且本地 adapter 未安装 | 警告"npm install 后可用"并忽略 mcp 段，引擎正常启动 |
| skills/mcp 未配置 | 零行为变化（回归保障） |

## 7. 测试

- schema 校验各失败分支（路径缺失、非 SKILL.md、名字非法/重复、mcp 形态错误）
- 三引擎生成快照：skills 复制结果（目录 + 伴随文件 + 幂等重同步含删除源后的清理）、OpenCode 生成文件含 provider+mcp 合并结果、OMP/PI mcp.json 内容（local 拆分、remote http 形态）、PI settings.json extensions 合并语义（已存在的 settings 不被覆盖）
- env 注入断言（mock spawn）：OpenCode 子进程 env 含 `XDG_CONFIG_HOME`，且 `XDG_DATA_HOME` 未被设置
- PI 启动命令优先级矩阵：config command > 本地 node_modules/.bin/pi-acp > PATH > npx（本地探测以临时目录模拟）
- PI mcp 未装 adapter 时的警告回落
- 无 skills/mcp 时回归：现有 105 测试全绿、生成文件内容与之前一致
- 实测：一个示例 skill（含伴随文件）+ 一个 local MCP server（如 `mcp-server-fetch`），三引擎 rehearsal 10/10；OpenCode/OMP/PI 对话中验证 skill 可被发现、MCP server 工具可被调用（PI 含 adapter 兼容性验证，不兼容则 pin 旧版并回填 §4）；结果回填 run-notes

## 8. 文档

- `gateway.config.example.json` 增补 `skills`/`mcp` 示例段（带注释说明）
- `solution/config-templates/README.md` 统一配置节增补能力供给说明（含 PI MCP 的 adapter 前提、OMP remote 验证状态的如实标注）
- README：快速开始增加 `npm install`（PI 本地化）说明、特性列表同步
- `INSTRUCTION.md`：环境准备更新（PI 从"无需安装"改为"npm install 本地化（可选，未装回落 npx）"）
- run-notes 新篇记录三引擎实测（含 PI adapter 兼容性结论）

## 9. 非目标

- 代码级 extension/plugin（TS/npm 包）的投放或声明（pi-mcp-adapter 是 MCP 的装配通道，不改变此边界）
- per-engine 的 skills/mcp 差异化覆盖
- skill frontmatter 解析/改写/跨引擎规范化
- MCP server 的健康检查、生命周期管理、工具白名单（引擎/adapter 自行拉起与管理）
- skill 的热更新（重启网关生效）

## 10. 实施后记（2026-09-03 三引擎实测回填）

真实 key 三引擎实测（结果表与调试叙事见 `docs/superpowers/plans/2026-09-03-unified-skills-mcp-run-notes.md` §3）对原设计的纠正与发现：

- **a) OMP ACP 模式 MCP 通道纠正**：原设计为写 `<stateDir>/omp/agent/mcp.json` 交由 OMP 原生发现；实测发现 omp 的 ACP 模式以 `enableMCP:false` 禁用磁盘 mcp.json 发现（上游 main.ts 注释与 issue #1234），该文件在 ACP 模式下不被读取。纠正为网关作为 ACP 客户端经 `session/new.mcpServers`（及 session/load、session/resume）传递（@agentclientprotocol/sdk v1 形态，见 §5 表）。mcp.json 文件仍会生成——对 TUI 模式 omp 有效且无害。
- **b) TLS 兼容问题（平台侧）**：2026-09-03 起 api.z.ai 平台升级（glm-5.3 上线）后，其 CDN 丢弃携带 MLKEM768 大 ClientHello 的 TLS 握手（Node 24/OpenSSL 3.5 默认发送；curl/Bun 不受影响——故 OMP/OpenCode 无恙而纯 Node 子进程的 PI 全挂，每轮模型调用 "Request timed out"）。网关处置：`bridge/src/tls-compat-shim.cjs` 经 `NODE_OPTIONS --require` 注入 pi 子进程（`ecdhCurve` 限定 `X25519:P-256:P-384`，在既有 NODE_OPTIONS 基础上追加、不覆盖；仅统一配置路径生效）。平台修复后 shim 冗余但无害。
- **c) omp 18.1.2 的 MCP 250ms 启动竞速窗口**：该版本会丢弃握手慢于 250ms 的 MCP server（上游已修，18.1.3+）。实测 remote（context7）正常挂载；慢启动 stdio（npx 冷启的 memory）在 18.1.2 上不挂载——升级 omp 即可（本机升级因 GitHub CDN 超时未完成，属环境问题而非网关问题）。
- **d) 示例包名纠正**：`mcp-server-fetch` 在 npm 上为 0.0.1-security 占位包（官方 fetch server 已从 npm 下架、仅存 Python 形态）；示例改为官方维护的 `@modelcontextprotocol/server-memory`（`gateway.config.example.json` 与 `solution/config-templates/README.md` 已同步）。
