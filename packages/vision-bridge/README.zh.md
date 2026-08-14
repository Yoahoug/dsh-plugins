# @dsh-plugins/vision-bridge

[English](README.md) | 中文

为 DeepSeek Harness 的**无视觉模型**提供图片理解能力。harness 会在路由模型的 `inputModalities` 未声明 `image` 时拒绝用户上传的图片（adapter 层的 `UNSUPPORTED_CONTENT`），本 Consumer 插件在不改动 harness 的前提下弥合这一缺口：用户图片经一个 OpenAI 兼容视觉端点转成文本描述，交给无视觉模型。

这是一个 **Consumer/函数插件**（`inject: ['llm', 'attachments', 'tools']`，无 default export）：它向 `ctx.tools` 注册面向模型的工具（`describe_image`），并注册一个 `llm/stream` waterfall 监听器改写无视觉路由的请求。它不拥有任何 `ctx.*` 键。

## 工作原理

每次模型调用都会在到达 adapter 之前穿过 `llm/stream` waterfall。桥接监听器解析确切路由的模态（`ctx.llm.resolveModelInfo`），然后：

| 路由模态 | 行为 |
|---|---|
| **声明 `image` 输入**（多模态） | **不暴露**该能力：从请求 `tools` 中剥掉 `describe_image`（schema 层面不可见），消息原样通过。直接调用工具在执行时被拒（`use read_image instead`）。 |
| **声明 `image` 输入且列入 `bridgeModels`** | **强制走桥接**：该模态声明是部署层的"谎言"（见下）——图片 block 被转换为提示、注入系统提示、确保 `describe_image`，执行 gate 放行调用。 |
| **`['text']` 或未声明**（无视觉） | 改写请求：每个 `image` block 变成一条中性的、携带 `attachmentId` 的提示（"The user attached an image … its content is available through the `describe_image` tool"）；幂等追加一段朴素系统提示（首行为 *"Attached images are accessible through the `describe_image` tool."*）；确保 `describe_image` schema 存在。注入文本刻意**不具侵略性**——没有任何插件命名空间 `[vision-bridge: …]` 标签到达模型。 |
| `resolveModelInfo` 失败 / `llm` 缺失 | 请求原样放行——插件故障绝不拦对话。 |

监听器不能修改（深度冻结的）请求，因此它构造一个**新请求**并**重入** `ctx.llm.stream()`。所有转换都幂等——第二次进入时报告"无变化"并落到 `next()`，这正是重入终止的原因（包的 invariant 伴侣在静态层面检查这一关系）。历史中已有 `describe_image` 结果的 `attachmentId`，其图片 block 会退化为简短占位"已在本次对话里描述过，请基于那条描述继续"，不再重复提示（避免同一图片的重复视觉往返）。

模型按提示调用 `describe_image(attachmentId)` 时，工具从**会话日志**反查完整附件引用（绝不信任模型复述的元数据——attachment 服务会同时校验字节与元数据），读取存储字节，POST 到视觉端点：

```
POST {baseURL}/chat/completions        model: gemini-3.6-flash（默认）
Authorization: Bearer <key>            content: [{text: describePrompt},
redirect: 'error' + user-agent        {image_url: {url: data:<mime>;base64,…}}]
reasoning_effort: low（默认）          （配置时才会发给端点）
```

返回的描述以 `[vision-bridge: describe_image <id>] <description>` 形式进入对话。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `http://10.66.66.66:8080/v1` | 视觉端点基址；追加 `/chat/completions`。与 opencode `codex` provider / `zai-vision` MCP 同源。 |
| `model` | `gemini-3.6-flash` | 视觉模型 id（与 opencode `zai-vision` MCP 默认一致）。 |
| `reasoningEffort` | `low` | 以 `reasoning_effort`（`low\|medium\|high`，OpenAI 风格）发给视觉模型的思考强度——仅对支持它的模型生效。 |
| `apiKeyEnv` | `$Z_AI_API_KEY` | 每次分析经凭据服务解析的凭据引用，回退到启动环境。 |
| `apiKey` | （未设置） | 密钥字面量；建议使用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `describePrompt` | 内置英文提示语 | 发送给视觉模型的"描述这张图片"指令。 |
| `bridgeModels` | `[]` | 即使声明 `image` 输入也强制走桥接的路由：`{provider, model}` 列表。见 [DeepSeek 部署](#deepseek-部署)。 |
| `enabled` | `true` | 总开关。为 `false` 时桥接完全惰性：`describe_image` 对一切路由隐藏，直接调用被拒。 |

```yaml
- id: vision-bridge
  name: '@dsh-plugins/vision-bridge'
  config:
    baseURL: http://10.66.66.66:8080/v1
    model: gemini-3.6-flash
    reasoningEffort: low
    apiKeyEnv: Z_AI_API_KEY
```

## DeepSeek 部署

harness Web 网关会在路由模型未**声明** `image` 输入时拒绝发送图片（"当前模型不支持图片，请切换支持图片的模型" / `MODEL_DOES_NOT_SUPPORT_IMAGES`）。官方 `dsh-llm-deepseek` 适配器对全部模型硬编码 `inputModalities: ['text']`，且没有任何配置字段可改，所以 Web 模型设置里找不到"给模型打标签"的地方——DeepSeek 模型编辑器只承载 id/name/context/maxTokens。

要让 DeepSeek 模型能发图（经本插件桥接）：

1. **改用 `dsh-llm-pi-ai` 承载该路由**（Web bundle 已内置），并为每个模型声明 `input: [text, image]`。pi-ai 路由完全可在 `settings.yaml`（及 Web Models 页的自定义 Provider 卡片）里配置；用 `compat: {thinkingFormat: deepseek, supportsReasoningEffort: true}` + `reasoningEfforts` 可以逐字节复刻 DeepSeek 线格式（`thinking: {type}` + `reasoning_effort`）。同时在补丁里禁用 `llm-deepseek`（两个适配器不能同时拥有 provider `deepseek-official`）。**provider id 必须命名为 `deepseek`**——pi-ai 按 provider 名/URL 自动检测推理模型，自定义 id（如 `deepseek-official`）会让 `supportsDeveloperRole` 解析为 `true`，导致适配器把 system prompt 序列化成 `developer` 角色，只接受 `system|user|assistant|tool|latest_reminder` 的 OpenAI 兼容网关会回 400 `unknown variant 'developer'`（见 docs/vision-bridge-development.md §8.4）。
2. **把该路由列入 `bridgeModels`**——第 1 步的声明只是为了过 Web 网关；背后的端点仍然收不了图片内容，所以必须让桥接对恰好这些路由做图片转换。否则请求会带着真正的 `image` block 到达 adapter 并失败。
3. 照常挂载桥接插件（上面的补丁 insert）并保持 `Z_AI_API_KEY` 已导出。

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    deepseek:
      displayName: DeepSeek (bridged)
      api: openai-completions
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: DEEPSEEK_API_KEY
      compat:
        thinkingFormat: deepseek
        supportsReasoningEffort: true
      models:
        - id: deepseek-v4-flash
          name: DeepSeek-V4-Flash
          contextWindow: 500000
          maxTokens: 256000
          input: [text, image]
          reasoningEfforts: { off: null, high: high, max: max }
        - id: deepseek-v4-pro
          name: DeepSeek-V4-Pro
          contextWindow: 500000
          maxTokens: 256000
          input: [text, image]
          reasoningEfforts: { off: null, high: high, max: max }

# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: llm-deepseek
  disabled: true
- insert:
    - id: vision-bridge
      name: '@dsh-plugins/vision-bridge'
      config:
        baseURL: http://10.66.66.66:8080/v1
        model: gemini-3.6-flash
        reasoningEffort: low
        bridgeModels:
          - provider: deepseek
            model: deepseek-v4-flash
          - provider: deepseek
            model: deepseek-v4-pro
```

## 设置命名空间

settings section 注册在 **`vision-bridge`** 命名空间（插件自有）。Web 设置卡片与 apiproxy 设置允许列表都硬编码了各自的命名空间，因此**本 section 没有 UI 卡片**——请通过 profile 补丁与环境变量配置（`export Z_AI_API_KEY=…`，与 opencode zai-vision MCP 完全一致）。已提交的 section 变更会投影到下一次操作，无需重新注册。

## 模型体验

无视觉模型在每次请求中看到：一段朴素的系统段落（"Attached images are accessible through the `describe_image` tool."）、`describe_image` 工具 schema，以及取代图片 block 的 "The user attached an image (attachmentId: …)" 提示——它永远收不到图片 token，adapter 的 `UNSUPPORTED_CONTENT` 拒绝也永远不会触发。注入刻意**不具侵略性**：没有插件命名空间标签到达模型，对话读起来像普通的"引用了一张图片"的文本，而不是一个集成补丁。

- **Token**：每张被桥接的图片耗费约 50 token 的提示文本，加上描述工具结果（通常 50–300 token，随图片复杂度增长）。视觉端点自身的生成在对话模型之外计费。系统提示在每轮请求中重新注入（它不是注册的 system-prompt section），这有利于 KV cache——见下。
- **KV cache**：系统提示与工具 schema 在给定路由上构成稳定的请求前缀，重复请求保持缓存命中；图片提示按 `attachmentId` 变化。描述文本只进入历史一次，并通过"已分析"占位复用，同一图片不会产生重复分析 token。
- **失败分类**：缺凭证点名引用（`no API key for "Z_AI_API_KEY"`）；HTTP 错误携带状态码与端点详情；响应体不可解析、`choices[0].message.content` 缺失均有明确分类；中止呈现为 `describe_image aborted`。

## invariant 伴侣

`@dsh-plugins/vision-bridge/invariant` 注册两条检查：① 对样本验证 `transformMessages`/`injectSystemHint`/`ensureDescribeImageTool` 幂等——`llm/stream` 重入必然终止的静态证据；② `describe_image` 未注册时到达监听器的请求直接失败（工具与监听器同生共死）。

## 已知限制与暂缓事项

- **`describe_image` 只接受 `attachmentId`**（用户上传的图片）。文件系统路径暂不支持——`file_path` 参数（read_image 式路径解析）留待后续。
- **无描述缓存**：同一图片每次调用都会重新分析（视觉延迟计入工具执行时间）。按 `attachmentId` 的 LRU 留待后续。
- **提示文本每轮从不可变日志重新生成**；`[vision-bridge` 提示本身不持久化——抑制重复提示靠"已分析"占位。
- **未声明模态按无视觉保守桥接**：`inputModalities: undefined` 的路由视为无视觉（与 `read_image` 的保守拒绝相反），因为拒绝必然导致含图请求失败，而桥接至少能工作。
- **全局监听器**：子 agent/子会话的请求同样会被改写；其会话日志同样可反查附件引用。
- **作用域工具限制在请求层被绕过**：对 `describe_image` 做了 scope-restrict 的部署，在纯文本路由上仍会看到该 schema 被重新注入（scope 过滤不达 `llm/stream` 层）；调用时的注册表级拒绝依然生效。
- **无 Web 设置卡片**（允许列表硬编码，见上文）。
