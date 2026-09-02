# 网关统一配置设计（引擎位置 + 模型注入）

- 日期：2026-09-02
- 状态：已评审通过（隔离生成 + 多模型默认粒度 + 方案 A 网关内建配置模块）
- 需求来源：用户需求——① 可配置每个引擎的可执行文件位置；② 在网关统一配置模型；③ 拉起引擎时自动携带对应配置，用户无需逐引擎手工配置模型
- 实现路径：方案 A —— 网关内建配置模块（加载/校验/生成/注入），配置成为网关一等能力

## 1. 背景与目标

当前模型的 provider 配置分散在三处用户目录（`~/.config/opencode/opencode.json`、`~/.omp/agent/models.yml`、`~/.pi/agent/models.json`），引擎位置不可配置（OMP/PI 的启动命令硬编码在 `HARNESS_PROFILES`，OpenCode 仅 `OPENCODE_COMMAND` 环境变量可换）。目标：

1. 单一配置文件描述模型 provider 与各引擎位置；
2. 网关启动时把统一模型配置**生成为各引擎的原生配置文件**，经环境变量指过去（隔离生成，不触碰用户已有 `~/.omp`、`~/.pi`、`~/.config/opencode`）；
3. 无配置文件时行为与现状完全一致（向后兼容）。

### 调研结论（注入机制，实测/源码确认）

| 引擎 | 配置注入机制 | 语义 | 副作用 |
|---|---|---|---|
| OpenCode | `OPENCODE_CONFIG=<文件路径>` | 指向自定义配置文件（官方文档） | 无，干净 |
| OMP | `PI_CONFIG_DIR=<home 下相对名>` | 配置根 = `path.join(homedir(), PI_CONFIG_DIR)`，默认 `.omp`；**绝对路径会被 join 拼坏，必须用相对名**（源码 `packages/utils/src/dirs.ts`） | 整个 OMP 根重定向：journal/历史库/auth 一并隔离 |
| PI | `PI_CODING_AGENT_DIR=<绝对路径>` | `@automatalabs/pi-acp@0.5.0` 内嵌 SDK 按 `$PI_CODING_AGENT_DIR` → `~/.pi/agent` 解析 agent 目录，`models.json` 在其中（包 README/deps.d.ts 确认） | 整个 agent 目录隔离：settings/extensions/auth/sessions |

连带影响：`pi-session-history.js:11-12` 已按 `PI_CODING_AGENT_SESSION_DIR`/`PI_CODING_AGENT_DIR` 解析，自动跟随；`omp-session-history.js:312` 硬编码 `~/.omp/agent/sessions`，需改为跟随 `PI_CONFIG_DIR`。`acp-client.js:129` spawn 未显式传 env（继承父进程），需增加注入通道。

## 2. 配置文件 schema

文件发现顺序：`--config <path>` > 环境变量 `GATEWAY_CONFIG` > `./gateway.config.json`（相对当前工作目录；存在才加载，不存在走旧行为）。

```json
{
  "model": {
    "providers": {
      "zaicoding": {
        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
        "apiKey": "{env:ZAI_API_KEY}",
        "api": "openai-completions",
        "models": { "glm-5.2": { "name": "GLM 5.2" } }
      }
    },
    "default": "zaicoding/glm-5.2"
  },
  "engines": {
    "opencode": { "command": "/opt/homebrew/bin/opencode" },
    "omp": { "command": "~/.local/bin/omp" },
    "pi": { "command": "/usr/local/bin/pi-acp", "model": "zaicoding/glm-5.2" }
  }
}
```

- **apiKey**：明文或 `{env:NAME}` 引用二选一。生成时保留引用语法交由引擎运行时展开（OpenCode 原生 `{env:}`、OMP 写 env 名、PI 写 `$NAME`）；明文则原样写入。
- **engines.<id>**（`opencode`/`omp`/`pi`）全部可选：`command`（绝对路径或命令名，支持 `~` 展开）、`args`（字符串数组，可选）、`model`（`providerID/modelID`，可选，覆盖默认模型）。未知引擎 id 报错。
- **args 组合语义**：配置 `args` 插在最终命令行中、引擎固有参数**之前**。omp 固有参数 `["acp"]` 恒保留（子命令模式标志）；pi 的 npx 包装参数（`--yes --package=... pi-acp`）仅在未配置 `command` 时使用——配置了 `command` 即完全替换 npx 调用（用户自装的 `pi-acp` 直接执行，无固有参数）；opencode 的 `serve --hostname --port` 由 host 层拼接，配置 `args` 追加在其后。
- **模型解析优先级**：`--model` > `GATEWAY_DEFAULT_MODEL` > `engines.<id>.model` > `model.default` > 内置默认 `zai/glm-5.2`。
- **引擎命令优先级**：配置 `engines.<id>.command` > 现有环境变量（`OPENCODE_COMMAND`）> profile 默认（`omp` / npx 拉起 `pi-acp`）。
- **校验**（失败即启动报错，不生成任何文件）：
  - JSON 语法；`model.providers` 非空时 `model.default` 必填且指向已定义的 provider/model；
  - provider id 限 `[a-z0-9-]+`（三引擎文件名/键安全；与 OMP/PI 内置 `zai` 家族同名时给 stderr 警告并继续）；
  - `api` 限 `openai-completions` | `openai-responses` | `anthropic-messages`（OMP/PI 已支持的集合；OpenCode 走 openai-compatible npm 适配器不受此约束）；
  - `baseUrl` 必须是 http(s) URL；`command` 为绝对路径时启动前检查存在性，不存在报错。

## 3. 隔离生成与注入

生成根目录 `~/.multi-agentengine-gateway/`（环境变量 `GATEWAY_STATE_DIR` 可覆盖，支持 `~` 展开），**只生成当前 `--engine` 所选引擎的配置**，每次启动幂等覆盖（目录已存在则重写文件）。

| 引擎 | 生成文件 | 注入 env | 生成内容 |
|---|---|---|---|
| OpenCode | `<state>/opencode/opencode.json` | `OPENCODE_CONFIG=<该文件绝对路径>` | `provider.<id> = { npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey }, models: { <modelId>: { name } } }`，含全部 providers |
| OMP | `<state>/omp/agent/models.yml` | `PI_CONFIG_DIR=<state 目录在 home 下的相对名>` | `providers: { <id>: { baseUrl, api, apiKey: <env名或明文>, models: [{id, name}] } }` |
| PI | `<state>/pi/agent/models.json` | `PI_CODING_AGENT_DIR=<state>/pi/agent`（绝对路径） | `{ providers: { <id>: { baseUrl, api, apiKey: "$<env名>" 或明文, models: [{id, name}] } } }` |

- **OMP 相对名换算**：`GATEWAY_STATE_DIR` 为默认值时 `PI_CONFIG_DIR=.multi-agentengine-gateway/omp`；若用户自定义 `GATEWAY_STATE_DIR` 不在 home 下或为绝对路径之外的形态，启动时报错说明该限制（OMP 语义所致）。
- **`{env:NAME}` 展开**：OpenCode 原样保留；OMP 写 env 名（`apiKey: ZAI_API_KEY`）；PI 写 `$ZAI_API_KEY`。引用的 env 变量未设置时 stderr 警告。
- **YAML 序列化**：OMP 的通用配置加载器同时接受 `models.json`（oh-my-pi docs/settings.md），实施时先实测 `models.json` 可否替代 `models.yml`；可用则全部生成 JSON、无需 YAML 序列化器，不可用则为该固定结构手写最小 YAML 转义序列化（网关核心零 npm 依赖约束不变）。
- **OMP journal 跟随**：`omp-session-history.js` 的默认 session 根改为 `path.join(homedir(), process.env.PI_CONFIG_DIR ?? ".omp", "agent", "sessions")`，与注入值一致。
- **ACP env 通道**：`acp-client.js` 构造参数增加可选 `env`，spawn 时 `{ env: { ...process.env, ...env } }`；`acp-engine.js`/`opencode-engine.js` 从 engineOptions 透传。

## 4. 启动接线

- `options.js`：新增 `--config <path>`（usage 文本同步）；未知引擎/字段报错。
- 新模块 `bridge/src/gateway/gateway-config.js`：
  - `loadGatewayConfig({ configPath, environment })` → `null`（未发现配置文件）或 `{ model, engines, path }`（已校验）；
  - `provisionEngineConfig(engineId, config, { stateDir })` → 写盘生成该引擎配置文件，返回注入 env（`OPENCODE_CONFIG` / `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`）；
  - `resolveEngineLaunch(engineId, config, environment)` → `{ command?, args?, env, defaultModel }`——纯函数解析优先级（不含写盘），其 `env` 即 `provisionEngineConfig` 的返回值，由 main.js 先 provision 再传入组装。
- `main.js`：`parseGatewayOptions` 后加载配置；有配置时仅对所选引擎 provision + 注入；`buildGateway(options)` 的 `engineOptions` 携带 `command/args/env`。
- `createEngine` 侧：`opencode-engine.js` 的 command 改为 `options.command ?? process.env.OPENCODE_COMMAND ?? "opencode"`；`acp-engine.js` 经 `resolveAcpLaunch` 结果被 `options.command` 覆盖（指定 command 时跳过 PATH 探测逻辑）。
- 注入 env 只作用于**引擎子进程**（spawn env），不修改网关自身 `process.env`，避免影响网关其他行为。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 配置文件 JSON 语法/校验失败 | 启动报错退出（含文件路径与原因），不生成任何文件 |
| `GATEWAY_STATE_DIR` 自定义路径不满足 OMP 相对名要求 | 启动报错，说明限制 |
| apiKey 引用的 env 未设置 | stderr 警告，继续启动（引擎侧随后会 401，报错可见） |
| 生成目录不可写 | 启动报错退出 |
| `command` 绝对路径不存在 | 启动报错退出 |
| provider id 与 OMP/PI 内置家族同名（如 `zai`） | stderr 警告并继续（用户可能有意覆盖） |

## 6. 测试

- `gateway-config.test.js`：加载发现顺序、schema 校验各失败分支、`resolveEngineLaunch` 优先级矩阵（config > env > profile 默认）、模型解析优先级矩阵。
- 生成快照：三引擎各自生成文件内容（固定 config 输入 → 精确字符串断言，覆盖 `{env:}` 与明文两种 apiKey、多 provider）。
- env 注入：mock spawn 断言 OpenCode host / ACP client 收到的 env 含 `OPENCODE_CONFIG` / `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` 且其余 env 不被覆盖。
- `omp-session-history` 路径跟随 `PI_CONFIG_DIR`。
- 回归：无配置文件时 `parseGatewayOptions`/启动路径行为不变（现有测试全绿）。
- 实测：`npm test` 后以真实配置文件分别三引擎 `npm run rehearsal` 10/10（沿用 run-notes 记录方式）。

## 7. 文档与交付物

- `README.md` 快速开始增补统一配置用法；`solution/config-templates/README.md` 增加"网关统一配置（推荐）"一节，原三引擎手工配置降为"引擎侧直配（可选）"；
- 新增 `gateway.config.example.json`（GLM5.2 示例，apiKey 用 `{env:ZAI_API_KEY}`）；
- `INSTRUCTION.md` 执行说明同步：设置 `ZAI_API_KEY` + 提供 `gateway.config.json` 即可，无需逐引擎配置；
- `gateway --help` usage 文本增加 `--config`。

## 8. 非目标

- 不做配置热重载（重启网关生效）；
- 不合并/修改用户已有引擎配置（隔离生成已定）；
- 不引入 npm 依赖、不改网关核心 import 边界（`gateway-import-boundary.test.js` 约束）；
- 不覆盖 claude/codex（不在网关引擎范围内）。
