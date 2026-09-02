# 多引擎网关演练执行笔记（Task 17 / M4 证据）

> 记录 `bridge/scripts/gateway-rehearsal.mjs` 演练脚本的执行情况：本机（macOS 开发机）实测了什么、
> 哪些步骤必须在装有引擎的机器 / Windows 实机上补测，以及 GLM 模板的实测验证步骤。
> 演练脚本用法：`node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217 --query "..."`
> （对**已启动**的网关跑完整评测链路，打印 ✓/✗ checklist，退出码 0=全绿 / 1=有红）。

## 1. 本机环境（实测前提，未造假）

- macOS（darwin 25.5.0 arm64），Node v24.14.0（`globalThis.EventSource` 为 undefined，演练脚本用 fetch 实现的 SSE 读取器替代 EventSource）。
- `command -v opencode omp pi` 均为空：**本机没有安装任何真实引擎**，因此以下实测全部走"真实网关 + 伪造上游"路径，未伪造任何"真实引擎已跑通"的结论。
- 无 Windows 实机；Windows 冒烟（第 3 节）待补。

## 2. 本机已实测：真实网关 + 伪造 opencode 上游（全链路 ✓）

与 Task 10 冒烟同法：网关 `main.js` 由 Node 真实拉起，`ManagedOpenCodeHost` 真实 spawn 上游进程并等
`/global/health` 就绪——只是"上游"是一个伪造的 `opencode`（实现 `/global/health`、`POST /session`、
`/session/status`、`POST /session/{id}/prompt_async`（204 + 广播 `message.part.updated` SSE）、
`GET /session/{id}/message`、abort/stop、DELETE、`/question`、`/permission`、SSE `/event`）。
演练流量穿过**真实网关 HTTP 面**（14 端点 + SSE），只有上游应答是假的。

伪造上游脚本（dev 用，不在仓库内）：`/tmp/fake-opencode-rehearsal.mjs`。

```bash
OPENCODE_COMMAND=/tmp/fake-opencode-rehearsal.mjs GATEWAY_OPENCODE_PORT=14517 \
  node bridge/src/gateway/main.js --engine opencode --port 6217 &
# stderr: gateway listening on http://localhost:6217 engine=opencode

node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217 \
  --query "请输出 hello world 并结束，不要执行任何其他操作"
```

Checklist 输出（连续 4 次运行均一致，退出码 0）：

```
✓ health
✓ create session
✓ prompt returns 204 (http 204)
✓ final message is assistant
✓ finish=stop
✓ step-finish present
✓ server.connected
✓ session.status
✓ session.idle
✓ permission endpoint

10/10 checks passed in 0.4s
```

失败路径（指向无服务端口）：10 行全 ✗、`0/10 checks passed`、退出码 **1**、无崩溃栈。会话清理经
`GET /session/status` 验证：4 轮演练后网关会话表为空 `{}`（DELETE 生效）；网关 SIGTERM 关闭后无残留
进程（网关与伪造上游均退出，6217/14517 端口释放）。

配套回归：`npm --prefix bridge test` → **526 pass / 0 fail**；`node bridge/scripts/package-solution.mjs`
→ solution.zip 重建（38 条目，与 Task 16 基线一致）。

## 3. 待补：装有引擎的机器上的真实演练（计划书 Task 17 Step 2）

本机无 opencode/omp/pi，以下命令在引擎安装机执行（每引擎一轮，未安装的跳过并在此记录）：

```bash
node bridge/src/gateway/main.js --engine opencode --port 6217 &
node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217
kill %1
# --engine omp / --engine pi 同理（换端口或先后执行）
```

预期：全部 ✓。若 OpenCode 真实上游的 `/event` 不发 `message.part.updated`（伪造假设与真实有出入），
修 opencode-engine 的事件来源（改为轮询 `/session/{id}/message` diff 出 part 更新）而不是放宽 rehearsal
检查；修正后补进 `gateway-opencode-engine.test.js` 的 fake 上游行为。
另需核验真实 opencode 的 `GET /question` / `GET /permission` 应答形态（伪造上游假设返回 JSON 数组）：
若真实上游 404 或返回非 JSON，网关的容错回退（listQuestions/listPermissions 捕获错误与非 JSON，降级为
`[]`）会让网关侧仍返回 200-`[]`，演练不受影响。
PI 若 `npx pi-acp` 拉起失败：记录现象，按风险预案在 `engine-adapter.js` 加 claude/codex case 顶替
（harness-profiles 已有对应 profile）。

**各引擎实测结果（待填）：**

| 引擎 | 机器/日期 | 结果 |
| --- | --- | --- |
| opencode（真实上游） | 待补 | 待补 |
| omp | 待补 | 待补 |
| pi | 待补 | 待补 |

## 4. 待补：Windows 实机冒烟（计划书 Task 17 Step 3）

1. Windows 机器 clone 仓库，或解压 solution.zip 到 `solution\`。
2. `npm install -g opencode`（及按需 omp；pi 无需安装，适配器经 `npx --package=@automatalabs/pi-acp pi-acp` 拉起）。
3. `gateway.cmd --engine opencode --port 6217`，另开终端：`node bridge\scripts\gateway-rehearsal.mjs --url http://localhost:6217`。
4. `--engine omp` 重复；PI 失败按第 3 节风险预案处理。
5. 结果回填本文件（每引擎 ✓/✗ 与现象）。

注意：演练脚本**不在 solution.zip 内**（见第 6 节），Windows 侧若只用 zip 包，需从仓库拷贝
`bridge/scripts/gateway-rehearsal.mjs`（纯 Node 内置模块单文件，直接 `node` 运行即可）。

**Windows 实测结果（待填）：** 待补。

## 5. 待补：GLM 模板实测验证（Task 15 README 的收尾步骤）

在装有真实引擎的机器上验证 `zai/glm-5.2` 出现在各引擎模型目录（详见
`solution/config-templates/README.md` 第 5 点）：

```bash
export ZAI_API_KEY=<key>   # Windows: setx ZAI_API_KEY <key> 后新开终端
opencode models | grep -i "zai\|glm"    # 期望出现 zai/glm-5.2
# omp / pi 按各自模型目录命令核验（omp --help / pi --help 查模型列表命令）
node bridge/scripts/gateway-rehearsal.mjs --url http://localhost:6217 \
  --query "请输出 hello world 并结束，不要执行任何其他操作"   # 默认模型即 zai/glm-5.2，走通即模板生效
```

若某引擎配置键名有出入：修正 `solution/config-templates/` 模板并回填 README。模板 `baseURL` 已直接写死为
官方端点 `https://api.z.ai/api/paas/v4`（网关与引擎都不做环境变量展开）；自定义端点按 README 第 1 节手工
改那一行即可，`opencode models` 实测是否出现 `zai/glm-5.2` 仍是模板生效的准绳。

**实测结果（待填）：** 待补。

## 6. 演练脚本与 solution.zip 的关系（预期行为，非缺陷）

`package-solution.mjs` 从 `bridge/src/gateway/main.js` 做相对导入闭包打包；演练脚本位于
`bridge/scripts/`（打包器不扫描该目录），因此 **solution.zip 不含 gateway-rehearsal.mjs**。这是有意的：
rehearsal 是开发/交付前自检工具，不是被评测网关的运行依赖。评测侧只依赖 zip 内的
`solution/gateway(.cmd)` → `code/bridge/src/gateway/main.js` 闭包（38 条目，已核对无 rehearsal 条目，
与 Task 16 的 ENGINES-DEPS.md 基线一致）。本笔记即 M4 交付证据：网关本体 + 全链路自检已在本机验证。

## 2026-09-02 真实 opencode 实测（macOS，opencode 1.18.26）

- L0 安装：`npm install -g opencode-ai` → `opencode --version` 1.18.26 ✓
- L1 serve：`opencode serve --port 14097` → `/global/health` `{"healthy":true}` ✓
- L2 网关：`AGENT_ENGINE=opencode node bridge/src/gateway/main.js --port 6217` → 1s 就绪 ✓
- L3 演练：rehearsal 10/10 ✓（真实 LLM 回复，finish=stop + step-finish 完成判定通过）
- 修复（727c96e）：真实 opencode 消息信封为 {info,parts} 而非规范扁平形状，normalize-opencode 现两者兼容（含 step-finish 补发与 tool 结果合成）；单元测试以实测数据为夹具
- 模型：GLM 内部部署端点未配置前，用 opencode 免费匿名模型（`GATEWAY_DEFAULT_MODEL=opencode/mimo-v2.5-free`）打通全链路；注意免费档有分钟级限流（偶发 0.2s 即 idle 且无消息，重试即可），正式评测换 GLM 端点后不受影响
- 待办不变：GLM 内部端点配置、OMP/PI 实测、Windows 实机

## 2026-09-02 真实 pi 实测（macOS，@automatalabs/pi-acp 0.5.0）

- 安装：无需单独安装，npx 冷启动 20s（ACP start 超时 90s 内）✓
- L2 网关：`AGENT_ENGINE=pi` 就绪 ✓；ACP initialize/authenticate 握手、session/new、configOptions 探测全部正常 ✓
- 模型目录：pi 无 provider 配置时通告空目录；网关默认模型 zai/glm-5.2 触发 bridge 模型校验，返回干净 500 "Harness model is not available: zai/glm-5.2"（非挂起/崩溃）✓
- 全 LLM 轮次：待 GLM 内部端点配置后按 config-templates/README §3 给 pi 配 OpenAI 兼容 provider，重跑 rehearsal
- 改进建议（未实施）：模型不可用错误当前映射 500 INTERNAL_ERROR，建议映射 400 VALIDATION_ERROR（judge 视角是请求参数问题而非网关故障）
- 引擎切换验证：opencode→pi 连续两轮 AGENT_ENGINE 切换启动均正常（调测指南第三步的部分验证）

## 2026-09-02 pi + GLM5.2 全链路打通（Coding 订阅端点）

- 配置（实测可用）：~/.pi/agent/models.json 定义 provider `zaicoding`（baseUrl https://api.z.ai/api/coding/paas/v4、api openai-completions、apiKey "$ZAI_API_KEY"、模型 glm-5.2）；网关以 GATEWAY_DEFAULT_MODEL=zaicoding/glm-5.2 启动
- rehearsal **10/10**（5.1s，真实 GLM 回复，完成判定全过）
- 坑1：GLM Coding 订阅的 key 只在 coding 端点有效（标准 paas/v4 端点 429）
- 坑2：Coding 订阅有瞬时限流，连续快速调用会失败，pi 侧统一报 "Internal error: provider error"（经网关为 500 INTERNAL_ERROR）——等待/重试即恢复，非网关问题
- 坑3：provider 命名避开 pi 内置的 `zai`（内置模型 glm-4.7/5-turbo/5.3 等并存），用独立名确保走自定义 baseUrl
- 状态：opencode ✓ 10/10、pi ✓ 10/10；剩 OMP 实测、Windows 实机、三引擎全量用例

## 2026-09-02 OMP 实测全通（omp 18.1.2）——三引擎齐了

- 安装：`curl -fsSL https://omp.sh/install | sh` → ~/.local/bin/omp（网关启动环境 PATH 需含该目录）
- 配置：~/.omp/agent/models.yml（YAML，与 pi 的 JSON 不同）定义 zaicoding provider → coding 端点；`omp models` 出现 zaicoding(1)→glm-5.2
- rehearsal **10/10**（12.5s，GLM5.2 真实回复，一次通过）
- config-templates/README §2/§3/§4 已回填为实测配置与端点匹配结论（Coding key 只认 coding 端点）
- 状态：OpenCode ✓ / OMP ✓ / PI ✓ 全部 10/10；剩 Windows 实机、评测全量用例

## 2026-09-02 重大修正：opencode 轮次失败真因是网关竞态，非限流

- 现象：opengine rehearsal 随机 7/10（0.2s 即回）与 10/10 交替；曾误诊为"免费模型限流"——排除：固定等待的探针总能拿到完整回复，轮次真实完成了
- 根因：opencode-engine 的 waitUntilIdle 把"turn 尚未进入 busy"误读为"已完成"（promptAndWait 有 started 守卫，轮询版没有）
- 修复：waitUntilIdle 增加 sawBusy 守卫 + 启动宽限 min(2000, timeout/2)ms；fake 上游新增 delayedBusyMs 复现竞态；回归测试固化
- 副产物：~/.config/opencode/opencode.json 的 zai provider（coding 端点 + {env:ZAI_API_KEY}）此前因竞态未获公平验证，修复后可正常使用（opencode models 已列出 zai/glm-5.2）；模板 api:{apiKey} 字段形状错误已修正为 options.apiKey
- 测试：534/534

## 2026-09-02（续）pi 超时真相与归一化假阳性修复

- pi + zaicoding/glm-5.2 的 500 复盘：AcpService 直连复现——pi 适配器对该端点 "Request timed out"（重试 4 次全空，56s），prompt 500 是正确行为；属 pi-acp 0.5.0（内嵌旧 SDK）与 Coding 端点的兼容性问题（曾成功过一次 5.1s，间歇性），引擎侧已知问题
- 连带发现并修复真 bug：normalize-acp 曾把"仅含错误、无任何输出"的 assistant 消息归一化为 finish=stop + step-finish（rehearsal 假阳性）——现在此类消息标 finish:"error"、空 parts、不伪造完成信号（规范 finish 枚举为"stop、tool-calls 等"，error 扩展合法且被自身校验器拒绝）
- acp-engine.prompt 加固保留：尾随 session.error 若最终 assistant 已有文本输出则不判失败（transcript 落盘轮询 3s）
- 测试：538/538
