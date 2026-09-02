# GLM5.2 provider 配置模板（OpenCode / OMP / PI）

本目录存放 GLM5.2 的 provider 配置模板与说明。网关以 `providerID/modelID` 的形式把模型名透传给底层引擎（wire name 为 `zai/glm-5.2`），因此每个引擎都需要一份指向 OpenAI 兼容端点的 provider 配置。默认端点为 Z.ai 官方地址 `https://api.z.ai/api/paas/v4`，已直接写入模板/配置说明；若使用自定义端点，手工把配置中的 `baseURL` 一行改为目标地址（可取环境变量 `ZAI_BASE_URL` 的值）。密钥通过环境变量 `ZAI_API_KEY` 注入。

## 1. OpenCode

把 `opencode.glm.json` 的内容并入 OpenCode 的全局配置文件 `~/.config/opencode/opencode.json`（Windows 为 `%USERPROFILE%\.config\opencode\opencode.json`），合并时保留该文件里已有的其他配置项。随后设置环境变量 `ZAI_API_KEY`（必填）。若使用自定义端点，把并入后配置中 `options.baseURL` 一行手工改为目标地址；不修改则使用模板自带的官方端点 `https://api.z.ai/api/paas/v4`。

模板中 `baseURL` 已直接写为默认官方端点 `https://api.z.ai/api/paas/v4`：OpenCode 与网关都**不会**对该字段做环境变量展开，自定义端点只能手工改这一行（若导出了环境变量 `ZAI_BASE_URL`，取其值填入即可，`ZAI_BASE_URL` 仅是惯用的取值来源，不是自动替换）。`{env:ZAI_API_KEY}` 则是 OpenCode 自带的环境变量引用写法，由 OpenCode 运行时读取，保持原样即可。

## 2. OMP（已实测，omp 18.1.2）

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

## 3. PI（已实测，@automatalabs/pi-acp 0.5.0）

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

三处配置真正必需的环境变量只有 `ZAI_API_KEY`（API 密钥）；网关默认模型通过 `GATEWAY_DEFAULT_MODEL` 设置并以 `providerID/modelID` 形式透传给所选引擎。

**端点与密钥类型必须匹配**（实测结论）：

- 智谱开放平台按量付费 key → `https://api.z.ai/api/paas/v4`
- **GLM Coding 订阅 key → `https://api.z.ai/api/coding/paas/v4`**（订阅 key 在标准 paas 端点一律 429）；Coding 订阅有瞬时限流，连续快速调用可能失败，等待重试即恢复
- 评测要求的内部部署端点 → 届时把 baseUrl 换为内部地址即可

**provider 命名**：OMP/PI 内置了 `zai` provider 家族，为避免与内置配置合并/遮蔽，实测推荐自定义 provider 用独立名 `zaicoding`，并以 `GATEWAY_DEFAULT_MODEL=zaicoding/glm-5.2` 启动网关（OpenCode 模板保持 `zai/glm-5.2` 不受影响）。

## 5. 演练验证

2026-09-02 已在 macOS 完成三引擎实测（详见 `docs/superpowers/plans/2026-09-01-multi-engine-gateway-run-notes.md`）：OpenCode 1.18.26、OMP 18.1.2、PI（pi-acp 0.5.0）经网关接入 GLM5.2 后 rehearsal 均 **10/10** 通过，本文 §1-§4 的配置即实测所用。剩余：Windows 实机复验、评测全量用例。若在 Windows 上配置键名有出入，按实机修正并回填本 README。
