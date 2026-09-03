# GLM5.2 provider 配置模板（OpenCode / OMP / PI）

本目录存放 GLM5.2 的 provider 配置模板与说明。网关以 `providerID/modelID` 的形式把模型名透传给底层引擎（wire name 为 `zai/glm-5.2`），因此每个引擎都需要一份指向 OpenAI 兼容端点的 provider 配置——推荐由网关统一配置自动生成（见下节），或按下文「引擎侧直配（可选）」手工提供。默认端点为 Z.ai 官方地址 `https://api.z.ai/api/paas/v4`，已直接写入模板/配置说明；若使用自定义端点，手工把配置中的 `baseURL` 一行改为目标地址（可取环境变量 `ZAI_BASE_URL` 的值）。密钥通过环境变量 `ZAI_API_KEY` 注入。

## 网关统一配置（推荐）

推荐用网关统一配置 `gateway.config.json` 一处声明模型 provider、能力供给（skills/mcp，可选）与各引擎选项：网关启动时校验配置、自动生成三引擎的隔离配置文件并注入对应引擎，无需按下文逐引擎手工并入。完整示例见仓库根 `gateway.config.example.json`（复制为 `gateway.config.json` 后按需修改）：

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
  "skills": ["./skills/demo-skill"],
  "mcp": {
    "fetch": { "type": "local", "command": ["npx", "-y", "mcp-server-fetch"] }
  },
  "engines": { "opencode": {}, "omp": {}, "pi": {} }
}
```

**配置文件位置与发现顺序**：`--config <路径>` > 环境变量 `GATEWAY_CONFIG` > 当前目录 `./gateway.config.json`；路径支持 `~` 展开。三者都未提供且当前目录无该文件时，网关按「引擎侧直配（可选）」路径工作。

**生成目录与注入变量**：配置含 `model.providers` 时，网关为所选 `--engine` 在 `~/.multi-agentengine-gateway/`（默认，可用 `GATEWAY_STATE_DIR` 覆盖）下生成该引擎的隔离配置文件，并把对应变量**只注入该引擎子进程环境**：

| 引擎 | 生成文件 | 注入变量 |
| --- | --- | --- |
| opencode | `<state>/opencode/opencode.json` | `OPENCODE_CONFIG`（文件绝对路径） |
| omp | `<state>/omp/agent/models.yml` | `PI_CONFIG_DIR`（home 相对名，内部已带 `/omp` 后缀） |
| pi | `<state>/pi/agent/models.json` | `PI_CODING_AGENT_DIR`（`pi/agent/` 目录绝对路径） |

其中 `<state>` 即状态目录。三套配置互不覆盖，也不动用户已有的 `~/.config/opencode/`、`~/.omp/`、`~/.pi/`。**`GATEWAY_STATE_DIR` 限制**：必须位于用户 home 目录之下——OMP 的 `PI_CONFIG_DIR` 语义是 home 相对目录名，网关会校验该约束并在违规时报错退出。

**字段说明**：

- `model.providers.<id>.baseUrl`：http(s) 端点，与密钥类型的匹配关系见第 4 节（GLM Coding 订阅 key 必须用 `/api/coding/paas/v4`）。
- `model.providers.<id>.apiKey`：明文密钥，或 `{env:NAME}` 引用环境变量（OMP 侧写入环境变量名、PI 侧转写为 `$NAME`、OpenCode 保留 `{env:NAME}` 原样由其运行时解析；引用的变量未设置时网关启动告警）。
- `model.providers.<id>.api`：`openai-completions` / `openai-responses` / `anthropic-messages` 三选一。
- `model.providers.<id>.models`：模型 id → 显示名的对象；`model.default` 为默认模型（`providerID/modelID` 形式，有 providers 时必填）。
- `skills`（可选）：字符串数组，每项为 skill 目录（内含 `SKILL.md`，可有伴随文件）或单个 `SKILL.md` 文件路径；支持 `~` 展开，相对路径相对**配置文件所在目录**解析。详见下节「能力供给」。
- `mcp`（可选）：对象，key 为 server 名，值分 `local`（`command` 完整数组 + 可选 `env`）/ `remote`（http(s) `url` + 可选 `headers`）两种形态。详见下节「能力供给」。
- `engines.<id>`（可选）：`command` 覆盖该引擎启动命令（支持 `~`，绝对路径不存在则启动报错）、`args` 追加启动参数（OMP 会自动补 `acp` 子命令）、`model` 为该引擎单独指定默认模型。
- 默认模型优先级：`--model` / `GATEWAY_DEFAULT_MODEL` 显式指定 > `engines.<id>.model` > `model.default`。
- provider id 建议用独立名（如 `zaicoding`）：OMP/PI 内置 `zai`/`zhipu`/`bigmodel`/`glm` provider 家族，撞名时网关启动告警提示。

### 能力供给（skills / mcp，可选）

统一配置可在模型之外一并声明**技能**与 **MCP server**：网关 provision 时把它们同步到所选引擎**正在读取的隔离位置**，引擎按各自原生机制发现（网关不改造引擎、不解析 SKILL.md frontmatter），隔离注入下用户已有 `~/.config/opencode/`、`~/.omp/`、`~/.pi/` 里的 skill 不受影响也不被使用（设计细节见 `docs/superpowers/specs/2026-09-03-unified-skills-mcp-design.md`）。

- **skills 路径引用与目录名规则**：每项为 skill 目录（内含 `SKILL.md`）或单个 `SKILL.md` 文件路径；支持 `~` 展开，相对路径相对配置文件所在目录。skill 名 = 目录名（直引文件时 = 其父目录名，文件名本身固定为 `SKILL.md` 不能作名字来源），须匹配 `[a-z0-9][a-z0-9-]*` 且列表内唯一。frontmatter 原样复制，由各引擎按各自规则解析（OpenCode 要求 frontmatter `name` 与目录名一致——由 skill 作者保证，不一致时仅该 skill 报错）。
- **复制语义**：每次启动**复制**（非符号链接，Windows 无特权符号链接会 EPERM）并幂等重同步——按 skill 清理重建各自目标目录 `<目标>/skills/<name>/`（非整棵 skills 根），源目录删除后目标不残留；SKILL.md 的伴随文件（参考文件、脚本等）随整目录一并复制。
- **mcp 形态**：`local` 为 `command` 完整数组（首元素可执行文件、其余为参数，元素均非空字符串）+ 可选 `env`（字符串键值对象）；`remote` 为 http(s) `url` + 可选 `headers`。`command`/`url`/`env` 值原样透传、不做 `${VAR}` 展开（MCP server 自身的环境变量用显式 `env` 字段表达）。

三引擎映射（skills/mcp 的目标位置都随既有隔离注入变量走，`<state>` 即状态目录）：

| 引擎 | skills 目标 | mcp 目标 | 机制 |
| --- | --- | --- | --- |
| opencode | `<state>/opencode/xdg/opencode/skills/<name>/` | 并入生成的 `<state>/opencode/opencode.json`：local → `mcp.<name> = { "type": "local", "command": [...], "environment": {...} }`，remote → `{ "type": "remote", "url": ..., "headers": {...} }`（官方 config schema，与 provider 段同文件、无新增注入变量） | skills 经注入的 `XDG_CONFIG_HOME=<state>/opencode/xdg` 发现——**只重定向配置目录**，auth/数据/缓存（`XDG_DATA_HOME` 等）不动，与 `OPENCODE_CONFIG` 叠加生效 |
| omp | `<state>/omp/agent/skills/<name>/` | `<state>/omp/agent/mcp.json`（标准 `mcpServers` 结构）：local → `{ "command": command[0], "args": [...], "env": {...} }`，remote → `{ "type": "http", "url": ..., "headers": {...} }` | 随 `PI_CONFIG_DIR` 被 OMP 原生发现 |
| pi | `<state>/pi/agent/skills/<name>/` | `<state>/pi/agent/mcp.json`（同 OMP 的 `mcpServers` 结构）+ `<state>/pi/agent/settings.json` 的 `extensions` 数组写入本地 adapter 入口 | skills 与 mcp.json 随 `PI_CODING_AGENT_DIR` 被 PI 发现；MCP 经 **pi-mcp-adapter** 装配——adapter 已随仓库 `npm install` 本地化（optionalDependencies），settings.json 为**合并语义**（既有主题/extensions 保留，只追加 adapter 入口，不整体覆盖） |

两个验证项状态（如实标注；实测结果见 `docs/superpowers/plans/2026-09-03-unified-skills-mcp-run-notes.md`）：

- **OMP remote 形态**：生成的 `{"type":"http",...}` 是否被 OMP 18.1.2 实际接受——以实测为准；若不支持，OMP+remote 将降级为"启动警告并忽略"并回填本节（local 形态不受影响）。
- **PI adapter 兼容性**：pi-mcp-adapter 2.32.1 面向最新 pi API，与 pi-acp 0.5.0 内嵌 pi 0.84.2 的扩展 API 兼容性——以实测为准；不兼容则 pin 到与 0.84.2 同期的 adapter 版本并回填。

错误处理：skill 路径不存在 / 目录缺 `SKILL.md` / 名字非法或重复、mcp 形态错误（`type`/`command`/`url`/`env`）——启动即报错退出，不生成任何文件；PI 配置了 mcp 但本地 adapter 未安装（未 `npm install`）时，网关 stderr 警告并忽略 mcp 段，引擎正常启动；skills/mcp 均未配置时行为与之前完全一致。

## 引擎侧直配（可选）

不走统一配置时，把 provider 配置按下面三节手工并入各引擎自己的配置文件，并用 `GATEWAY_DEFAULT_MODEL=zaicoding/glm-5.2` 指定默认模型。

### 1. OpenCode

把 `opencode.glm.json` 的内容并入 OpenCode 的全局配置文件 `~/.config/opencode/opencode.json`（Windows 为 `%USERPROFILE%\.config\opencode\opencode.json`），合并时保留该文件里已有的其他配置项。随后设置环境变量 `ZAI_API_KEY`（必填）。若使用自定义端点，把并入后配置中 `options.baseURL` 一行手工改为目标地址；不修改则使用模板自带的官方端点 `https://api.z.ai/api/paas/v4`。

模板中 `baseURL` 已直接写为默认官方端点 `https://api.z.ai/api/paas/v4`：OpenCode 与网关都**不会**对该字段做环境变量展开，自定义端点只能手工改这一行（若导出了环境变量 `ZAI_BASE_URL`，取其值填入即可，`ZAI_BASE_URL` 仅是惯用的取值来源，不是自动替换）。`{env:ZAI_API_KEY}` 则是 OpenCode 自带的环境变量引用写法，由 OpenCode 运行时读取，保持原样即可。

### 2. OMP（已实测，omp 18.1.2）

配置文件为 `~/.omp/agent/models.yml`（YAML；Windows 对应 `%USERPROFILE%\.omp\agent\models.yml`）。新增 provider：

```yaml
providers:
  zaicoding:
    baseUrl: https://api.z.ai/api/coding/paas/v4
    api: openai-completions
    apiKey: ZAI_API_KEY
    models:
      - id: glm-5.2
        name: GLM 5.2 (coding)
```

`apiKey: ZAI_API_KEY` 是环境变量名引用（OMP 运行时解析）。验证：`omp models` 应出现 `zaicoding (1) → glm-5.2`。注意两点：① OMP 内置了 `zai` provider 家族，自定义 provider 建议用独立名（如 `zaicoding`）确保走自定义 baseUrl；② omp 安装在 `~/.local/bin`（macOS/Linux 安装脚本），网关启动环境的 PATH 需包含该目录，否则 spawn `omp` 失败。

### 3. PI（已实测，@automatalabs/pi-acp 0.5.0）

配置文件为 `~/.pi/agent/models.json`（JSON，注意与 OMP 的 YAML 不同）。新增 provider：

```json
{
  "providers": {
    "zaicoding": {
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "api": "openai-completions",
      "apiKey": "$ZAI_API_KEY",
      "models": [
        { "id": "glm-5.2", "name": "GLM 5.2 (coding)" }
      ]
    }
  }
}
```

`"$ZAI_API_KEY"` 为环境变量引用。PI 也内置 `zai` provider 家族，同样建议用独立 provider 名。PI 本体无需安装（适配器内嵌 SDK）。

## 4. 环境变量与端点

引擎侧直配路径真正必需的环境变量只有 `ZAI_API_KEY`（API 密钥）；网关默认模型通过 `GATEWAY_DEFAULT_MODEL` 设置并以 `providerID/modelID` 形式透传给所选引擎。统一配置路径同理：`apiKey` 写成 `{env:ZAI_API_KEY}` 时需要设置该变量，明文写入配置时无需任何环境变量。

**端点与密钥类型必须匹配**（实测结论）：

- 智谱开放平台按量付费 key → `https://api.z.ai/api/paas/v4`
- **GLM Coding 订阅 key → `https://api.z.ai/api/coding/paas/v4`**（订阅 key 在标准 paas 端点一律 429）；Coding 订阅有瞬时限流，连续快速调用可能失败，等待重试即恢复
- 评测要求的内部部署端点 → 届时把 baseUrl 换为内部地址即可

**provider 命名**：OMP/PI 内置了 `zai` provider 家族，为避免与内置配置合并/遮蔽，实测推荐自定义 provider 用独立名 `zaicoding`，并以 `GATEWAY_DEFAULT_MODEL=zaicoding/glm-5.2` 启动网关（OpenCode 模板保持 `zai/glm-5.2` 不受影响）。

## 5. 演练验证

2026-09-02 已在 macOS 完成三引擎实测（详见 `docs/superpowers/plans/2026-09-01-multi-engine-gateway-run-notes.md`）：OpenCode 1.18.26、OMP 18.1.2、PI（pi-acp 0.5.0）经网关接入 GLM5.2 后 rehearsal 均 **10/10** 通过，本文「引擎侧直配」§1-§3 的配置即实测所用。统一配置路径（`gateway.config.json` 自动生成/注入）的三引擎 rehearsal 待真实 key 环境复验（步骤与预期见 `docs/superpowers/plans/2026-09-02-unified-gateway-config-run-notes.md`）。剩余：Windows 实机复验、评测全量用例。若在 Windows 上配置键名有出入，按实机修正并回填本 README。
