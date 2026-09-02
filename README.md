# Multi-AgentEngine-Gateway

多引擎可替换 Agent 网关——按《多agent引擎可替换架构实现-任务书》构建，精确实现《Agent 网关接口规范》定义的 14 个 HTTP 端点与 SSE 事件流，通过统一的 `EngineAdapter` 接口接入三种 Agent 引擎，启动参数/环境变量切换。

```
评测系统 → gateway :6217（14 端点 + /event SSE）
              └─ EngineAdapter 接口
                   ├─ opencode-engine（托管 opencode serve，HTTP+SSE 适配）
                   └─ acp-engine（omp/pi 共用，ACP stdio JSON-RPC，权限真实挂起）
```

- **网关核心零外部依赖**（纯 Node 内置模块），与引擎驱动层解耦，由 import 边界测试强制执行
- `prompt_async` 阻塞至本轮完成；消息含 `tool_calls` / `info.finish` / `step-finish`，满足裁判完成判定
- 引擎切换：`--engine opencode|omp|pi` 或环境变量 `AGENT_ENGINE`

## 快速开始

```bash
# 1. 安装引擎（按需）
npm install -g opencode-ai                 # OpenCode
curl -fsSL https://omp.sh/install | sh     # OMP（注意 PATH 需含 ~/.local/bin）
# PI 无需安装（@automatalabs/pi-acp 经 npx 拉起）

# 2. 配置 GLM5.2（各引擎 provider 配置，见 solution/config-templates/README.md）

# 3. 启动网关（默认端口 6217）
AGENT_ENGINE=opencode node bridge/src/gateway/main.js --port 6217

# 4. 全链路自检（10 项 ✓/✗）
npm run rehearsal

# 5. 测试 / 打包评测交付物
npm test                    # 规范符合性 + 单元/集成测试
npm run package             # 生成 solution.zip
```

## 目录结构

```
bridge/src/gateway/        网关核心（路由/SSE/会话表/交互队列/消息规范化）+ engines/ 适配器
bridge/src/*.js            引擎驱动闭包（ACP/OpenCode 宿主，清单见 gateway/ENGINES-DEPS.md）
bridge/test/               gateway 测试套件（含双引擎规范符合性测试）
bridge/scripts/            打包（package-solution.mjs）与演练（gateway-rehearsal.mjs）
solution/                  评测交付物（INSTRUCTION.md、启动包装、GLM 配置模板）
docs/superpowers/          设计文档、实施计划、实测记录（run-notes）
```

## 实测状态

OpenCode 1.18.26 / OMP 18.1.2 / PI(pi-acp 0.5.0) 三引擎经网关接入 GLM5.2 后 rehearsal 均 10/10（2026-09-02，macOS）。详见 `docs/superpowers/plans/2026-09-01-multi-engine-gateway-run-notes.md`。待办：Windows 实机复验、评测全量用例。

## 来源与许可

本项目迁移自 [lzzd555/Multi-AgentEngine-Harness](https://github.com/lzzd555/Multi-AgentEngine-Harness)（分支 `gateway-multi-engine`，其 upstream 为 [TangHui-Best/Multi-AgentEngine-Harness](https://github.com/TangHui-Best/Multi-AgentEngine-Harness)）的网关实现，引擎驱动层源自 [harness-remote](https://github.com/giuliastro/harness-remote)（Apache-2.0）。沿用 Apache-2.0 许可并保留原项目声明，见 [LICENSE](LICENSE)。
