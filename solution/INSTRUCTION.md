# Agent 网关参赛作品执行说明

## 环境准备

1. Node.js ≥ 22（ACP 适配器路径需要；OpenCode-only 时 ≥ 20 亦可）。`node -v` 确认。
2. 安装引擎（按需，评测哪个引擎装哪个）：
   - OpenCode：`npm install -g opencode`
   - OMP：`curl -fsSL https://omp.sh/install | sh`（装至 `~/.local/bin`，需在 PATH；注意 npm 上的 `oh-my-pi` 包与此项目无关，勿用 npm 安装；MCP 慢启动 server 需 ≥18.1.3）
   - PI：`npm install` 本地化（可选；未装时 npx 兜底）
3. GLM5.2 配置（推荐：网关统一配置）：设置环境变量 `ZAI_API_KEY=<你的key>`（必填，配置中经 `{env:ZAI_API_KEY}` 引用），并在启动目录提供 `gateway.config.json`——完整示例见仓库根 `gateway.config.example.json`，最小配置如下（网关按 `--config <路径>` > 环境变量 `GATEWAY_CONFIG` > 启动目录 `./gateway.config.json` 的顺序自动发现）：

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
     "engines": { "opencode": {}, "omp": {}, "pi": {} }
   }
   ```

   `baseUrl` 需与密钥类型匹配：GLM Coding 订阅 key 用 `https://api.z.ai/api/coding/paas/v4`（上例默认；订阅 key 在标准 paas 端点一律 429），智谱按量付费 key 改为 `https://api.z.ai/api/paas/v4`（详见 `code/solution/config-templates/README.md` 第 4 节）。网关启动时自动在 `~/.multi-agentengine-gateway/` 下为所选引擎生成隔离配置并注入，**无需手工修改各引擎配置文件**。Windows 下持久生效用 `setx ZAI_API_KEY <key>`（需新开一个终端窗口才对后续进程生效）；仅当前会话生效用 PowerShell 的 `$env:ZAI_API_KEY = "<key>"`（或 cmd 的 `set ZAI_API_KEY=<key>`）；macOS/Linux 用 `export ZAI_API_KEY=<key>`。
   可选路径（引擎侧直配）：不走统一配置时，按 `code/solution/config-templates/README.md` 的「引擎侧直配（可选）」把 provider 配置并入对应引擎，并以 `GATEWAY_DEFAULT_MODEL=zaicoding/glm-5.2` 启动网关；默认端点 `https://api.z.ai/api/paas/v4` 已直接写入模板，自定义端点时导出 `ZAI_BASE_URL=<自定义地址>` 并把配置中 `baseURL` 一行手工改为该值（网关与引擎都不会自动展开该变量）。
4. 可选：统一能力供给（skills / MCP）。在同一 `gateway.config.json` 中追加 `skills`（SKILL.md 技能目录的路径数组）与 `mcp`（MCP server 声明）两段，网关启动时自动同步到所选引擎的隔离位置，三引擎均支持。`mcp` 兼容标准 mcpServers 格式——`command` 可为字符串配合 `args` 数组、`type` 可省略、整段 `{"mcpServers": {...}}` 外壳可直接贴入；`env`/`headers` 值支持 `{{VAR}}`/`${VAR}`/`$VAR` 环境变量引用（启动前 `export` 对应变量，网关展开后注入；未设置时启动警告并保留原样）。示例与各引擎映射（PI 的 MCP 需 `npm install` 装配 adapter）见 `code/solution/config-templates/README.md` 的「能力供给」一节。
5. 依赖安装：可选 `npm install`——本地化 PI（`@automatalabs/pi-acp`）与 `pi-mcp-adapter`（optionalDependencies，离线/安装失败不阻断）；未安装时 PI 适配器经 npx 拉起（首跑会下载、较慢），OpenCode/OMP 不受影响，网关核心仍零依赖。

## 执行方式

```bat
cd solution
gateway.cmd --engine opencode --port 6217
gateway.cmd --engine omp --port 6217
gateway.cmd --engine pi --port 6217
```

macOS/Linux 等价形式：`./gateway --engine <id> --port 6217`。直接调用入口：`node code\bridge\src\gateway\main.js --engine <id> --port 6217`（macOS/Linux 路径分隔符为 `/`）；环境变量 `ENGINE=<id>`、`GATEWAY_PORT=6217` 亦可。启动成功标志：stderr 打印 `gateway listening on http://localhost:6217 engine=<id>`。

## 执行完成判定

- 服务常驻（评测调用期间不退出）。就绪探测：`GET /health` → `{"ok":true}`。
- 评测按《Agent 网关接口规范》调用全部接口；每轮完成判定：SSE `session.idle` 或最后一条 assistant 消息 `info.finish=stop` 且 parts 含 `step-finish`。
- 需要人工交互时，评测通过 `GET /question`、`POST /question/{id}/reply`、`GET /permission`、`POST /permission/{id}/reply` 自动提交。

## 生成结果交付件说明

- 评测过程中如需产物，会话消息可随时 `GET /session/{id}/message` 获取；服务日志输出到 stderr。
