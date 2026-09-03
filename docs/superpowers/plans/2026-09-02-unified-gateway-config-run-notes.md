# 网关统一配置实测执行笔记（unified-gateway-config / Task 6）

> 记录 `gateway.config.json` 统一配置特性的实测情况：本机（macOS 开发机，Node v24.14.0）验证了什么、
> 哪些步骤因缺真实 `ZAI_API_KEY`（本环境不可用）而**待用户在有 key 的环境执行**，以及执行命令与预期结果。
> 配置发现顺序、生成目录与注入变量等行为细节见 `solution/config-templates/README.md` 的「网关统一配置（推荐）」一节。

## 1. 本机已验证（无 key 环境，全部真实执行）

### 1.1 全量测试套件（验证门）

```bash
cd bridge && node --test
```

结果：**101 pass / 0 fail**（含 gateway-config 加载校验、三引擎隔离配置生成/注入、--config 启动接线、
OpenCode/ACP 命令覆盖、OMP/PI 路径重定向的全部单元与集成测试），duration ≈ 3.1s，退出码 0。

### 1.2 示例配置加载 + 三引擎生成预览（直接调函数级冒烟）

用仓库根新增的 `gateway.config.example.json` 逐项核验（`loadGatewayConfig` + `provisionEngineConfig`）：

- 加载/校验通过，warnings 为空（`zaicoding` 不与内置 `zai`/`zhipu`/`bigmodel`/`glm` 家族撞名）。
- opencode：`OPENCODE_CONFIG=<state>/opencode/opencode.json`（绝对路径）。
- omp：`PI_CONFIG_DIR=.multi-agentengine-gateway/omp`（home 相对名，内部已带 `/omp` 后缀），生成 `<state>/omp/agent/models.yml`。
- pi：`PI_CODING_AGENT_DIR=<state>/pi/agent`（绝对路径），生成 `<state>/pi/agent/models.json`。
- 反向验证 `GATEWAY_STATE_DIR` 限制：stateDir 指到 home 之外（`/tmp/...`）时 OMP 供给按设计报错
  `GATEWAY_STATE_DIR must live under the home directory for the OMP engine`。
- 该步产物（写入真实 `~/.multi-agentengine-gateway/` 的两个文件）系函数级探针生成、非文档化流程，
  已删除，避免与待用户执行的 rehearsal 产物混淆。

### 1.3 无 key 端到端冒烟（文档承诺的 `--config` 入口）

throwaway 配置 `{"engines":{}}`（无 providers，不生成任何引擎配置）放临时目录，真实拉起网关：

```bash
node bridge/src/gateway/main.js --config /tmp/.../gateway.config.json --engine opencode --port 6217 &
```

- stderr 打印 `gateway listening on http://localhost:6217 engine=opencode` ✓（文档承诺的启动成功标志）
- `GET /health` → `{"ok":true}` ✓；`kill` 后进程干净退出（exit 0），无残留进程、端口释放 ✓
- 证明文档「复制示例配置 → `--config`（或自动发现）→ 启动」流程机械上端到端可用。

## 2. 真实 GLM key 的三引擎 rehearsal（2026-09-03 完成，macOS）

配置方式即 §2 步骤：`cp gateway.config.example.json gateway.config.json` + `export ZAI_API_KEY=<key>`（GLM Coding 订阅 key，coding 端点，key 仅存于环境变量、配置文件为 `{env:}` 引用）。引擎版本：OpenCode 1.18.26 / omp 18.1.2 / pi-acp 0.5.0（npx）。

**各引擎实测结果：**

| 引擎 | 版本 | rehearsal | 生成文件核验 | 干净 HOME 复验 |
| --- | --- | --- | --- | --- |
| opencode | 1.18.26 | **10/10**（2.5s） | opencode.json 生成（0600），`OPENCODE_CONFIG` 经 ps 实证注入子进程 | **10/10**（2.5s） |
| omp | 18.1.2 | **10/10**（2.3s） | models.yml 生成（0600，YAML 引号正确），`PI_CONFIG_DIR` 注入实证，OMP 自身 agent.db/models.db 写入隔离根 | **10/10**（1.8s） |
| pi | pi-acp 0.5.0 | **10/10**（13.5s，含 npx 拉起） | models.json 生成（0600），`PI_CODING_AGENT_DIR` 注入实证（PI 将 auth.json/models-store.json 写入隔离目录） | 未单独复验（注入机制与 omp 同构） |

补充实测记录：

- 真实对话验证（pi 引擎，经网关 prompt）：模型回答"我是由 Z.ai 训练的 GLM 大语言模型驱动的编程助手，在 pi 编码代理环境中帮助你读写代码……"，`finish=stop` + `step-finish` 齐全。
- 无 key 时的失败形态（补充于 2026-09-02 冒烟）：请求真实到达 coding 端点并返回 401，OpenCode 以 `session.error` SSE 事件呈现（含完整 APIError 详情），OMP 以消息文本 + step-finish 呈现，busy→idle 状态机正确收尾。
- 本轮实测未遇到 Coding 订阅瞬时限流（每引擎 rehearsal + 附加对话共 6 轮真实调用）。
- 历史回填说明：`~/.multi-agentengine-gateway/` 生成文件中 apiKey 均为 `{env:}` / 环境变量名 / `$NAME` 引用形态，密钥从未落盘。

## 3. 遇到的问题

- （本机验证阶段）无异常：套件全绿、冒烟一次通过。示例配置校验 warnings 为空。
- 历史背景：引擎侧直配路径的三引擎 10/10 已于 2026-09-02 实测（见
  `2026-09-01-multi-engine-gateway-run-notes.md`）；统一配置路径与其共享同一套生成产物格式
  （§1.2 已核验形状一致），差异仅在「网关自动生成注入」替代「手工并入」，故风险集中在 §2 的真实轮次复验。
