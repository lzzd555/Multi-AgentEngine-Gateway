# Agent 网关参赛作品执行说明

## 环境准备

1. Node.js ≥ 22（ACP 适配器路径需要；OpenCode-only 时 ≥ 20 亦可）。`node -v` 确认。
2. 安装引擎（按需，评测哪个引擎装哪个）：
   - OpenCode：`npm install -g opencode`
   - OMP：`npm install -g oh-my-pi`（提供 `omp` 命令，含 `omp acp` 模式）
   - PI：无需单独安装 `pi`，适配器经 `npx --package=@automatalabs/pi-acp pi-acp` 拉起（首次会下载）
3. GLM5.2 配置：设置环境变量 `ZAI_API_KEY=<你的key>`（必填）。默认端点 `https://api.z.ai/api/paas/v4` 已直接写入模板，无需改动；自定义端点时导出 `ZAI_BASE_URL=<自定义地址>` 并按 `code/solution/config-templates/README.md` 第 1 节把配置中 `baseURL` 一行手工改为该值（网关与引擎都不会自动展开该变量）。Windows 下持久生效用 `setx ZAI_API_KEY <key>`（需新开一个终端窗口才对后续进程生效）；仅当前会话生效用 PowerShell 的 `$env:ZAI_API_KEY = "<key>"`（或 cmd 的 `set ZAI_API_KEY=<key>`）；macOS/Linux 用 `export ZAI_API_KEY=<key>`。随后按 `code/solution/config-templates/README.md` 把 provider 配置并入对应引擎。
4. 依赖安装：无第三方 npm 依赖，无需 `npm install`。

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
