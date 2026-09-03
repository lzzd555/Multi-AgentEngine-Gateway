# 网关统一能力供给设计（Skills + MCP）

- 日期：2026-09-03
- 状态：已评审通过（范围 Skills+MCP、来源=路径引用、实现=扩展现有 provision 机制）
- 需求来源：用户需求——在 `gateway.config.json` 一处声明 skill 与 MCP server，网关 provision 时自动同步到所选引擎，无需逐引擎配置
- 前置设计：`2026-09-02-unified-gateway-config-design.md`（本设计建立在其隔离注入机制之上，分支堆叠于 feature/unified-gateway-config）

## 1. 背景与目标

统一配置已覆盖模型与引擎位置，但 skill/MCP 仍需逐引擎手工配置；且隔离注入使各引擎用户目录（`~/.omp`、`~/.pi`、`~/.config/opencode`）里已装的 skill 被绕开。目标：配置文件新增 `skills` / `mcp` 两段，provision 时把能力同步到**所选引擎正在读取的隔离位置**——引擎按各自原生机制发现，网关不做任何引擎改造。

### 调研结论（机制矩阵，源码/文档确认）

| 能力 | OpenCode 1.18.26 | OMP 18.1.2 | PI（pi-acp 0.5.0 内嵌 pi 0.84.2） |
|---|---|---|---|
| Skills | 全局 `~/.config/opencode/skills/<name>/SKILL.md`（经 `XDG_CONFIG_HOME` 可重定向）；frontmatter `name`（1-64，小写字母数字连字符，须与目录名一致）/`description`（1-1024）必填 | `<OMP 根>/agent/skills/<name>/SKILL.md`，仅一级目录（嵌套被忽略）；`description` 对原生 provider 必填（frontmatter 解析由引擎完成，网关不解析） | `<agentDir>/skills/<name>/SKILL.md`；`dist/core/resource-loader.js` 中 `join(this.agentDir, "skills")` 为发现根，目录含 SKILL.md 即技能根、递归发现 |
| MCP | 生成文件 `mcp.<name>` 字段：`{ "type": "local", "command": ["…"], "environment": {} }` 或 `{ "type": "remote", "url": "https://…", "headers": {} }`（官方 config schema） | 用户级 `~/.omp/agent/mcp.json`（`docs/mcp-config.md`），标准 `mcpServers` 结构 | **无原生配置文件约定**：pi 本体经 extension 包装配（如 pi-mcp-adapter 读 `~/.pi/agent/mcp.json`，首跑需网络装包）——本设计不做 |

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

## 4. MCP 供给

| 引擎 | 机制 |
|---|---|
| OpenCode | 并入生成的 `opencode.json`：local → `mcp.<name> = { type: "local", command, environment: env }`；remote → `{ type: "remote", url, headers }`。与 provider 段同文件，无新增注入变量 |
| OMP | 生成 `<stateDir>/omp/agent/mcp.json`（标准 `mcpServers` 结构）：local → `{ "command": command[0], "args": command.slice(1), "env": env }`；remote → `{ "type": "http", "url": url, "headers": headers }`。**实施验证项**：remote 的 http 形态以 OMP 18.1.2 实测为准；若实测不支持，OMP+remote 降级为"启动警告并忽略"并回填本节（local 不受影响） |
| PI | **v1 不支持**：配置了 `mcp` 且引擎为 pi 时，stderr 打一条警告（列出被忽略的 server 名）并跳过。升级路径（不在本期）：经 `<stateDir>/pi/agent/settings.json` 的 `packages` 装 MCP adapter extension 并生成其 mcp.json |

统一 schema 的 `command` 为完整数组（OpenCode 原生形态）；OMP 生成时拆分为 `command[0]` + `args`。`command`/`url`/`env` 值中的 `${VAR}` 等**不做展开**，原样透传（MCP server 的环境变量用显式 `env` 字段表达）。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| skill 路径不存在 / 目录无 SKILL.md / 名字非法或重复 | 启动报错退出，不生成任何文件 |
| mcp 校验失败（type/command/url/env 形态） | 同上 |
| 目标 skills 目录不可写 | 启动报错退出 |
| OMP+remote MCP 实测不支持 | 警告并忽略该 server（§4 实施验证项的降级分支） |
| PI + mcp 段 | 警告并忽略全部，引擎正常启动 |
| skills/mcp 未配置 | 零行为变化（回归保障） |

## 6. 测试

- schema 校验各失败分支（路径缺失、非 SKILL.md、名字非法/重复、mcp 形态错误）
- 三引擎生成快照：skills 复制结果（目录 + 伴随文件 + 幂等重同步含删除源后的清理）、OpenCode 生成文件含 provider+mcp 合并结果、OMP mcp.json 内容（local 拆分、remote http 形态）、PI 跳过 + 警告
- env 注入断言（mock spawn）：OpenCode 子进程 env 含 `XDG_CONFIG_HOME`，且 `XDG_DATA_HOME` 未被设置
- 无 skills/mcp 时回归：现有 105 测试全绿、生成文件内容与之前一致
- 实测：一个示例 skill（含伴随文件）+ 一个 local MCP server（如 `mcp-server-fetch`），三引擎 rehearsal 10/10；OpenCode/OMP 对话中验证 skill 可被发现、MCP server 工具可被调用；结果回填 run-notes

## 7. 文档

- `gateway.config.example.json` 增补 `skills`/`mcp` 示例段（带注释说明）
- `solution/config-templates/README.md` 统一配置节增补能力供给说明（含 PI MCP 不支持、OMP remote 验证状态的如实标注）
- README 快速开始与特性列表同步
- run-notes 新篇记录三引擎实测

## 8. 非目标

- 代码级 extension/plugin（TS/npm 包）的投放或声明
- per-engine 的 skills/mcp 差异化覆盖
- PI 的 MCP 支持（升级路径已记录）
- skill frontmatter 解析/改写/跨引擎规范化
- MCP server 的健康检查、生命周期管理、工具白名单（引擎自行拉起与管理）
- skill 的热更新（重启网关生效）
