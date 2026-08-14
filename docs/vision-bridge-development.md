# vision-bridge 插件开发文档 — DeepSeek Harness 无视觉模型的图片理解能力

> 目标:在不修改 DSH 主仓库源码的前提下,给**无视觉模型**(如 `deepseek-v4-flash` / `deepseek-v4-pro`,`inputModalities` 只含 `text`)提供图片理解能力:用户上传的图片经一个 OpenAI 兼容视觉端点(`http://10.66.66.66:8080/v1`,复用本机 opencode 的凭证,模型固定为 `gemini-3.6-flash`)转成文本描述,再交给无视觉模型。**多模态模型(声明 `image` 输入)默认不暴露该能力**。
>
> 参考实现:本机 `~/.config/opencode/plugins/vision-helper.ts`(opencode 的视觉桥接插件)。本文档由对主仓库 `deepseek-ai/deepseek-harness`(2026-08-14,`0.1.0-rc.5` 工作树)的调研写成,与 `docs/tavily-search-development.md` 同属一个调研体系。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| 需要改主仓库吗? | **不需要**。全部经由插件 + profile 用户补丁层 |
| 插件形态? | **Consumer 型函数插件**(不是 Provider:没有现成宿主 registry 容纳"图片转文本"能力)。它做两件事:① 注册 `describe_image` 工具;② 监听 `llm/stream` waterfall 拦截请求 |
| 无视觉模型怎么"看到"图片? | `llm/stream` 监听器把请求里的 `image` content block **替换为提示文本**(含 `attachmentId`),并注入系统提示:看到提示就调用 `describe_image` 工具。工具读取附件字节 → 调用视觉端点(`model: gemini-3.6-flash`)→ 返回文本描述进历史 |
| 多模态模型为何默认不暴露? | 同一监听器对声明 `image` 输入的模型**从请求 `tools` 中剥掉 `describe_image`**(schema 层面不可见)+ 工具执行时二次 gate 拒绝。DSH 的模态来源是 `ctx.llm.resolveModelInfo(provider, model).inputModalities`,无需维护模型名单 |
| 无视觉模型当前会怎样? | 用户上传图片 → 消息含 `image` block → `llm-pi-ai`/`llm-deepseek` adapter 直接抛 `UNSUPPORTED_CONTENT`(`contentHasImage` 检查),整轮对话失败;`read_image` 工具也被严格门控拒绝(`assertImageCapableRoute`)。这正是插件的痛点 |
| 凭证与端点 | 复用 opencode `codex` provider / `zai-vision` MCP 的 `baseURL: http://10.66.66.66:8080/v1` 与 `apiKey: sk-6136...`,默认 `apiKeyEnv: Z_AI_API_KEY`(与 opencode zai-vision 一致),模型为 `gemini-3.6-flash`(即 opencode `zai-vision` 默认 `Z_AI_VISION_MODEL`,带 `reasoning_effort: low`;本插件按其接口能力选用) |

**核心机制**:DSH 的 LLM 请求管线在 adapter 之前有一条 `llm/stream` **waterfall**(Cordis 事件)。监听器可以**短接**(不调用 `next()`,返回自己的流)。请求对象 `GenerateOptions` 是深度冻结的,不能原地修改——所以监听器的做法是:构造一份"转换后"的新请求(图片→提示文本、system 注入、tools 增删),**重入** `ctx.llm.stream(newOptions)`;第二次进入时所有转换条件都已不成立,自然走 `next()` 到 adapter,**幂等且无递归**。

---

## 2. 参考实现解剖:opencode vision-helper

`~/.config/opencode/plugins/vision-helper.ts`(139 行)做的事:

1. `experimental.chat.system.transform`:读模型能力(`capabilities.input.image` / `modalities.input` 含 `image`),**无视觉 → 注入系统提示**:用户粘贴图片时插件会保存到临时目录并在消息中注入 `[opencode-vision: Image #1 ...]` 提示,模型看到提示必须调用 `zai-vision_analyze_image` 工具分析图片。
2. `experimental.chat.messages.transform`:
   - 移除历史消息里插件先前注入的提示(防重复);
   - 无视觉模型:把 `file` part(base64)保存到 `/tmp/opencode-vision/image<N>/`,消息末尾追加 `[opencode-vision: ...]` 提示(带本地路径);
   - 多模态模型:什么都不做(图片原样进上下文)。
3. opencode.json 里 `zai-vision` MCP server 配置:`Z_AI_API_KEY: sk-6136...`、`Z_AI_BASE_URL: http://10.66.66.66:8080/v1/`、`Z_AI_VISION_MODEL: gemini-3.6-flash`(本插件复用同一模型与 baseURL/apiKey);`codex` provider 同源 baseURL/apiKey。

**移植到 DSH 的差异**:

| opencode | DSH(本插件) |
|---|---|
| MCP 工具 `zai-vision_analyze_image`(参数:本地路径) | 工具 `describe_image`(参数:`attachmentId`,opencode 的"临时目录保存"在 DSH 里是**多余**的——DSH 的 attachment 服务已把用户上传图片持久化为 content-addressed 对象) |
| 消息里注入 `[opencode-vision: ...]` 提示 | `llm/stream` 监听器把 `image` block 替换为 `[vision-bridge: ...]` 提示(DSH 的 adapter 遇到 `image` block 直接抛错,所以是**替换**而不是"追加提示 + 保留图片") |
| 系统提示注入(system.transform) | 同一监听器把 `options.system` 末尾幂等追加一段提示 |
| 多模态模型不注入 | 多模态模型:提示不注入、`describe_image` 从 `options.tools` 剥离、工具执行 gate 拒绝 |
| 图片去重(移除历史注入) | 历史中已出现该 `attachmentId` 的 `describe_image` 结果时,替换为简短占位文本(不重复提示) |

---

## 3. DSH 机制调研(事实与依据)

### 3.1 图片如何进入模型请求,无视觉模型为何失败

- 用户经 web 上传图片 → `apiproxy.durablePromptContent` 验证字节/格式 → `attachments.saveImage()` 持久化 → 消息里是 `{ type: 'image', attachment: ImageAttachmentRef }` block(`packages/attachment/attachment/src/types.ts`)。上传 preflight **不检查模型模态**。
- `llm-pi-ai` adapter(`packages/llm/llm-pi-ai/src/adapter.ts:302`):`containsImage && !model.input.includes('image')` → 抛 `LlmError('... does not support image input', 'UNSUPPORTED_CONTENT')`。
- `llm-deepseek` adapter(`packages/llm/llm-deepseek/src/serialize.ts:64`):`assertTextOnly` 对含图请求直接抛 `UNSUPPORTED_CONTENT`(该 adapter 全部模型 `inputModalities: ['text']`)。
- `read_image` 工具(`packages/fs/tool-fs/src/read-image.ts:64`):`assertImageCapableRoute` 要求当前路由模型显式声明 `image` 输入,文本模型/未声明模态/不在目录的模型一律拒绝("does not declare image input")。

**结论**:无视觉模型会话里,图片一旦进入消息,请求在 adapter 层必然失败;插件必须在 `llm/stream` 层(adapter 之前)把 `image` block 换成文本。

### 3.2 `llm/stream` waterfall —— 插件的挂载点

`LlmRuntime.stream()`(`packages/llm/llm/src/index.ts:913`)实现为:

```ts
return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
```

Cordis waterfall 语义(`vendor/cordis/src/events.ts:234`):监听器收到 `(options, next)`;调用 `next()` 进入链上下一环(最终 `adapterStream`),**不调用 `next()` 即短接**(监听器自己返回流)。已有先例:

- `session-title`:`ctx.on('llm/stream', (options, next) => { ...; return next() }, { global: true, prepend: true })` —— 只读不拦。
- agent-loop 测试(`tests/request-reconstruction.spec.ts:372`):一个短接监听器可以**完全拥有**一个未注册路由(不调 `next()`,直接返回自产流)。
- **请求内容深度冻结**:`GenerateOptions` 不可原地修改("a mutation attempt on the frozen request content throws into the step (loud, not silent)",同文件:485)。

**因此监听器只能"构造新请求重入"**,不能改 `options.messages`。重入路径:

```ts
ctx.on('llm/stream', (options, next) => {
  return (async function* () {
    const transformed = await bridge.transform(options)   // 新对象;条件不满足时返回 null
    if (transformed === null) { yield* next(); return }   // 原样走下游(含第二次重入)
    yield* ctx.llm.stream(transformed)                    // 重入;转换幂等 → 第二次必然走 next()
  })()
})
```

关键点:监听器本身必须是**同步函数**(返回 AsyncGenerator),不能是 async function——`agent.ts:345` 是 `for await (const chunk of stream)`,waterfall 若返回 `Promise<AsyncIterable>` 会炸。异步逻辑(模态解析、附件读取)放进生成器体内。

### 3.3 模型模态判定

`ctx.llm.resolveModelInfo(provider, model, signal)` → `LlmResolvedModelInfo.inputModalities?: readonly ModelModality[]`(`llm/src/types.ts:242`,"absent means unknown, while an explicit omission is negative capability")。`llm-pi-ai` 的 `resolveModel` 映射 `inputModalities: [...resolvedModel.input]`;`llm-deepseek` 恒为 `['text']`。**判定:`inputModalities !== undefined && inputModalities.includes('image')` 为真 → 多模态,不暴露;否则(含 `['text']` 与 `undefined`)→ 桥接**。

与 `read_image` 门控的差异:read_image 对 `undefined`(未知)保守拒绝;本插件对 `undefined` 视为"无法确认有视觉",**保守桥接**(不桥接会让含图请求必然失败,桥接至少能工作;README 记录该取舍)。

### 3.4 attachment 读取

`ctx.attachments.readImage(ref: ImageAttachmentRef, signal?)`(`attachment/src/index.ts:59`)按 content-addressed id 读字节并校验摘要与元数据(`attachment-local/src/store.ts:204`)。**必须提供完整 ref**(mediaType/bytes/width/height 与存储一致,否则 `ATTACHMENT_CORRUPT`),不能只凭 id 构造。

所以 `describe_image` 的 `attachmentId` 参数需在**会话日志**里反查完整 ref:`exec.agent.session.events` 中 `user/message` 事件(`SessionEventMap['user/message']: UserMessage`,data.content 是 `ContentBlock[]`)与 `tool/result` 事件(`message.content` 为 `ToolResultMessage`)递归查找 `{type:'image', attachment}` 且 `attachment.attachmentId === 目标`。这是确定性解析,不依赖模型复述元数据。

### 3.5 工具注册与执行上下文

`ctx.tools.register(defineTool({...}))`(`read-image.ts:130` 为模板)。执行时 `ToolExecution.agent.session` 提供会话(README 记录:无 agent 上下文的直接调用(如测试)走 `agent.options` 回退)。gate 模式照抄 `assertImageCapableRoute`(`read-image.ts:64`):`exec.agent?.session.requestHeader()?.config` → 回退 `exec.agent?.options`。

### 3.6 系统提示注入

不注册 `systemPrompt.section`(那是静态/每 assembly 求值,且拿不到当前路由模型);直接在 `llm/stream` 转换里改 `options.system` 字符串,幂等标记为段落首行。

### 3.7 凭证与安全(沿用 web-search-tavily 规范)

- `Config.apiKeyEnv` 默认 `Z_AI_API_KEY`(与 opencode zai-vision MCP 的环境变量一致,部署时 `export Z_AI_API_KEY=sk-6136...` 即复用同一把 key);`apiKey` 字面量仅作 fallback;凭证经 `ctx.get('credentials')` 解析,缺失时 `launchEnvironmentOf(ctx).get(env)` fallback。
- 视觉端点请求必须 `redirect: 'error'`(凭证不跨源转发),`user-agent: deepseek-harness/<version>`。
- baseURL 是部署方显式配置(默认内网代理),插件不暴露任意 URL fetch → 无新增 SSRF 面。

---

## 4. 插件设计

包:`packages/vision-bridge/`,npm 名 `@dsh-plugins/vision-bridge`,工具 `describe_image`,settings 命名空间 `vision-bridge`,标记前缀 `[vision-bridge:`。

### 4.1 文件结构

```
packages/vision-bridge/
├── src/index.ts        函数插件(name/inject/Config/apply + settings section + 组装)
├── src/transform.ts    纯函数:image block → 提示文本、system 幂等注入、tools 增删(全部可单测)
├── src/provider.ts     VisionBridgeProvider:describe_image 工具定义 + 视觉端点调用
├── src/resolve.ts      附件 ref 反查(session 日志 → ImageAttachmentRef)+ 路由模态判定
├── src/types.ts        wire 类型(ChatCompletion 请求/响应)
├── src/invariant.ts    包级 invariant 伴侣
└── tests/              见 §5
```

### 4.2 转换器(`llm/stream` 监听器)行为

```
resolveModelInfo(options.provider, options.model)
├─ 失败/不可用 → yield* next()(保守放行,插件故障不拦对话)
├─ 多模态(声明 image)→ 构造新请求:tools 剥掉 describe_image → ctx.llm.stream(重入)
└─ 无视觉 → 构造新请求:
     messages: 递归替换 image block → [vision-bridge: ...] 提示文本
       (已在历史中描述过该 attachmentId → 替换为简短占位,不重复提示)
     system:   幂等追加「你无法直接看到图片…调用 describe_image」段落
     tools:    幂等补入 describe_image schema
   → ctx.llm.stream(重入)
```

幂等保证(重入第二次必然 `next()`):替换后 messages 无 image block;system 含标记段落不再追加;tools 含/不含目标工具不再增删。

### 4.3 `describe_image` 工具

- 参数:`attachmentId`(string,必填)——提示文本里原样给出,模型照抄。
- gate(执行时):路由解析失败 / llm 不可用 → 拒绝(与 read_image 同哲学:未知能力不冒险);模型声明 image → 拒绝并指导用 `read_image`(多模态防线 ②)。
- 流程:session 日志反查 ref → `attachments.readImage` → base64 → `POST {baseURL}/chat/completions`,`model: gemini-3.6-flash`,`reasoning_effort: low`(默认;见 §8.4),`content: [{text: describePrompt}, {image_url: {url: data:<mime>;base64,...}}]`,`redirect: 'error'`。
- 结果:`choices[0].message.content` 文本,包装为 `[vision-bridge: describe_image <id>]` 前缀(供转换器幂等识别)。
- 错误分类:缺凭证(点名 `apiKeyEnv`)、HTTP 非 2xx(带 body 详情)、响应不可解析、AbortError → 工具 isError 文本。

### 4.4 Config 与默认值

| 键 | 默认 | 含义 |
|---|---|---|
| `baseURL` | `http://10.66.66.66:8080/v1` | 视觉端点(复用 opencode codex/zai-vision 同源) |
| `model` | `gemini-3.6-flash` | 视觉分析模型(与 opencode zai-vision 的 `Z_AI_VISION_MODEL` 一致) |
| `reasoningEffort` | `low` | 以 `reasoning_effort`(`low\|medium\|high`,OpenAI 风格)发给视觉模型的思考强度,仅对支持它的模型生效(见 §8.4) |
| `apiKeyEnv` | `Z_AI_API_KEY` | 凭证引用(环境变量/credentials 服务) |
| `apiKey` | 无 | 字面量 fallback(密钥不进配置文件) |
| `describePrompt` | 内置英文提示语 | 发给视觉端点的"描述这张图片"指令 |
| `enabled` | `true` | 总开关 |

全部可选,`apply` 内填默认;settings section 经 `installSettingsSection` 注册,source thunk 投影 options。

### 4.5 invariant

安装时检查两条关系:① `transformMessages` 幂等(`transform(transform(x))` 与 `transform(x)` 逐 block 相等——防重入死循环的静态证据);② `ctx.tools.get('describe_image')` 已注册(工具与监听器同生共死)。

---

## 5. 测试计划

| 文件 | 覆盖 |
|---|---|
| `tests/transform.spec.ts` | 纯函数:image block 替换、tool-result 嵌套替换、已分析占位、system 幂等注入、tools 增删幂等、多模态剥离 |
| `tests/provider.spec.ts` | 工具 gate(多模态拒绝/无视觉放行/路由缺失拒绝)、请求整形(POST body/headers/redirect)、凭证解析(credentials→env→字面量)、错误分类(HTTP/解析/abort/缺凭证点名) |
| `tests/redirect.spec.ts` | **真实 HTTP** 证明 `redirect: 'error'` 拒绝跨源 Location(凭证不跨源,用真实服务器) |
| `tests/settings.spec.ts` | settings section 读写 + HMR 安全注册(注册后 dispose,观察 section 移除) |
| `tests/vision-bridge.e2e.ts` | 真实端点冒烟(有 `$Z_AI_API_KEY` 自跑,无 key 自跳过) |

---

## 6. 安装与验证

```sh
# 1. 构建
pnpm --filter @dsh-plugins/vision-bridge build

# 2. 安装进 profile
dsh plugin --profile <name> add file:/Users/yoahoug/Desktop/dsh-plugins/packages/vision-bridge

# 3. 凭证(复用 opencode 的 key)
#    ~/.dsh/.env 或 shell:export Z_AI_API_KEY=sk-6136c88132958303aef1bfcb313f8d0036a417b9584c635c626f716ac88ade6b

# 4. profile 补丁(~/.dsh/profiles/<name>/cordis.patch.yml)
- insert:
    - id: vision-bridge
      name: '@dsh-plugins/vision-bridge'
      config:
        baseURL: http://10.66.66.66:8080/v1
        model: gemini-3.6-flash
        reasoningEffort: low
```

验证清单:

- [ ] `pnpm run test`(插件包):转换/门控/凭证/错误分类单测通过
- [ ] `redirect.spec.ts`:真实 HTTP 证明重定向不被跟随
- [ ] `vision-bridge.e2e.ts`:有 key 时真实端点返回图片描述;无 key 自跳过
- [ ] 无视觉模型(`deepseek-v4-flash`)会话:上传图片 → 模型收到 `[vision-bridge: ...]` 提示 → 调用 `describe_image` → 返回图片描述
- [ ] 多模态模型(声明 image 输入的模型)会话:请求 `tools` 中无 `describe_image`;直接调用也被拒
- [ ] 主仓库 `git status` 干净

---

## 7. Known Limitations(详见 README)

1. `describe_image` 只接受 `attachmentId`(用户上传的图片);文件系统路径图片暂不支持(需要 `read_image` 式的路径解析,后续可加 `file_path` 参数)。
2. 视觉端点延迟计入工具执行时间;无进程内描述缓存(每轮同图多次分析),后续可加 LRU。
3. 转换提示在每轮请求中都会由日志里的 image block 重新生成(日志不可变),但"已分析"占位抑制了重复提示;`[vision-bridge` 提示本身不持久化。
4. 模态判定对 `inputModalities: undefined` 的模型保守桥接(与 read_image 的保守拒绝相反,理由见 §3.3)。
5. 子 agent/子会话的请求同样会被监听器处理(全局监听),其会话日志同样可反查附件。
6. UI 设置卡片:web 设置页没有 vision-bridge 的卡片(白名单写死 web 命名空间),配置经 profile 补丁/env;与 tavily 的 §4.3 遗留问题同类。

---

## 8. 补充调研(2026-08-15):Web 发送层准入拦截与 `bridgeModels`

### 8.1 实测现象与根因

§3.1 曾断言"上传 preflight 不检查模型模态"。实测发现:**发送(而非上传)时有一道比 adapter 更早的准入检查**,位于 `packages/host/apiproxy/src/api-proxy.ts` 的 `prompt` RPC(约 2482–2495 行):

```ts
if (hasImage) {
  const current = selectionFor(agent).current
  const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model)
  if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
    return err(request, { code: 'attachment-error', message: `Model "${current.model}" does not support image input.`,
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
  }
}
```

即:`resolveModelInfo` 的 `inputModalities` **明确不含 `image`** 时,图片进不了会话历史,`llm/stream` waterfall(本插件挂载点)根本轮不到。Web 端把该错误映射为「当前模型不支持图片,请切换支持图片的模型」(`ui-conversation/src/client/locales.ts` `image.modelUnsupported`)。

### 8.2 为什么 Web 设置里没有"打标签"入口

模态的唯一权威来源是**适配器的 `resolveModel`**。`llm-deepseek` 适配器(`packages/llm/llm-deepseek/src/adapter.ts:113,190`)对全部模型硬编码 `inputModalities: ['text']`,其 Config schema 没有模态字段,Web 的 DeepSeek 模型编辑器(`ui-settings-models/src/client/DeepSeekModelsEditor.tsx`)因此只有 id/name/context/maxTokens。apiproxy 的 Config 也无任何准入开关。**结论:不改主仓库的前提下,该路由的模态只能靠换适配器声明。**

### 8.3 修复:llm-pi-ai 声明 image + bridgeModels 强制桥接

- `llm-pi-ai`(`dsh-base` bundle 已内置)的 provider 配置支持按模型声明 `input: [text, image]`(route 级 `defaultInput` 或 model 级 `input`),且 `resolveModel` 原样返回 —— Web 准入即通过。线格式与 llm-deepseek 完全一致:`compat: {thinkingFormat: 'deepseek', supportsReasoningEffort: true}` + `reasoningEfforts`(pi-ai `api/openai-completions.js` 的 deepseek dispatch 产出 `thinking:{type:enabled/disabled}` + `reasoning_effort`,与 `llm-deepseek/src/serialize.ts` 逐字段一致;`off` 空值 → map 缺席 → dispatch 发 `thinking:{type:disabled}`)。
- 但声明 `image` 会让本插件的多模态分支"不桥接" → 图片带着真实 image block 到达 pi-ai 并失败。因此新增配置 **`bridgeModels`**:列出的 `{provider, model}` 即使声明 `image` 也强制走桥接(监听器转换 + 工具 gate 放行,同一谓词,见 `provider.ts` 的 `isBridgedRoute`)。默认空列表,行为与旧版完全一致。
- 部署形态(web profile):
  - `settings.yaml`:新增 `llm-pi-ai.providers.deepseek`(baseURL/apiKeyEnv/compat/models,含 `input: [text, image]` 与 `reasoningEfforts`),移除 `llm-deepseek` section;
  - `cordis.patch.yml`:`- id: llm-deepseek, disabled: true`(避免 `DUPLICATE_ADAPTER`,两个适配器不能同时拥有 provider `deepseek-official`);insert vision-bridge 并配置 `bridgeModels: [{provider: deepseek, model: deepseek-v4-flash}, {provider: deepseek, model: deepseek-v4-pro}]`。
  - `agent-default-model` 改为 `provider: deepseek`。
  - **provider id 必须是 `deepseek`,不能是 `deepseek-official`**:pi-ai 按 provider 名/URL 自动检测推理模型(见 §8.5),自定义 id 会把 system prompt 序列化成 `role: "developer"`,Console Go 网关 400(unknown variant `developer`)。`deepseek` 触发 pi-ai 的 DeepSeek 检测:`system` 角色、`thinkingFormat: deepseek`、`requiresReasoningContentOnAssistantMessages`。
- 相关代码路径:监听器分支 `index.ts`(`isBridgedRoute` 命中 → `bridgeRequest` 而非 `stripVisionToolRequest`)、工具 gate `provider.ts:assertBridgedRoute`(命中直接放行)、配置投影 `resolveOptions`(规范化成 `${provider}/${model}` Set)。测试:`provider.spec.ts`(gate 放行 + listener 多模态桥接)、`settings.spec.ts`(section 往返)。

### 8.4 视觉模型与思考强度(2026-08-15)

§3.7/§4.4 早期把视觉端点模型定为 `gpt-5.6-luna`。实测 Console Go 网关 `POST /v1/chat/completions`:

- `model: gemini-3.6-flash` 完全可用 —— 与 opencode `zai-vision` MCP 的 `Z_AI_VISION_MODEL` 默认完全一致,复用同一模型即少一份心智负担。
- 请求体加 `reasoning_effort: "low"` 被接受且生效(同图 `low` 的 reasoning_tokens 66 → `high` 时 53…实际以端点返回为准;值域是 OpenAI 风格 `low|medium|high`,`high` 也可用)—— 视觉分析默认用**低思考强度**,减少延迟与 token。
- 图片(`content` 含 `image_url` data URL)与 `reasoning_effort: "low"` 共存正常,无 wire 冲突。

因此将默认模型改为 `gemini-3.6-flash`,并新增配置 **`reasoningEffort?: 'low'|'medium'|'high'`**(默认 `low`):

- `types.ts`:`VisionChatCompletionRequest` 增加可选 `reasoning_effort`(仅当设置时进入请求体)。
- `provider.ts`:`VISION_BRIDGE_DEFAULT_MODEL = 'gemini-3.6-flash'`、新增 `VISION_BRIDGE_DEFAULT_REASONING_EFFORT = 'low'` 与 `VisionBridgeOptions.reasoningEffort`,`describeImageViaEndpoint` 在 body 上 `${options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }}`。
- `index.ts`:Config 增加 `reasoningEffort`(schema `z.union(['low','medium','high'] as const).default(low)`,显式默认不隐藏),`resolveOptions` 投影 `reasoningEffort: config.reasoningEffort ?? 'low'`。
- 测试:`provider.spec.ts` 断言默认 body 带 `reasoning_effort:'low'`,且配置 `reasoningEffort:'high'` 可覆盖;`settings.spec.ts` 断言 section 里存 `reasoningEffort` 会投影到下一次执行。

### 8.5 400 `unknown variant 'developer'` 的根因与修复(2026-08-14)

**症状**:切到 pi-ai 承载 DeepSeek 路由后,每轮请求 400:`Failed to deserialize the JSON body ... messages[0].role: unknown variant 'developer'`。

**根因**:pi-ai 的 `openai-completions` dispatch 对**推理模型**(`model.reasoning = true`,由 `reasoningEfforts` 或 `compat.supportsReasoningEffort` 触发)按 OpenAI 新规范把 system prompt 序列化为 `{role: "developer"}`(`api/openai-completions.js` 的 `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`)。`supportsDeveloperRole` 由 `detectCompat` 按 provider 名与 baseURL 推断:标准域名/标准 provider 名 → `true`;`deepseek-official` 是自定义名、`10.66.66.66` 是内网 IP,两者都不命中任何 `isNonStandard` 分支 → `true`。而 Console Go 网关(serde 反序列化)只接受 `system | user | assistant | tool | latest_reminder`,`developer` → 400。

**修复**(纯配置层):provider id 从 `deepseek-official` 改为 `deepseek`。pi-ai `detectCompat` 中 `provider === 'deepseek'` 命中 `isDeepSeek` → `isNonStandard` → `supportsDeveloperRole = false` → role 回退 `system`;同时 `thinkingFormat: deepseek`、`requiresReasoningContentOnAssistantMessages: true` 自动检测,与手动 compat 配置一致。无需改任何源码;若 Console Go 网关侧能支持 `developer` 角色,则也可在网关修(改名即可回退)。

### 8.6 非侵入式注入措辞(2026-08-15)

早期转换器向模型注入的文本带明显插件痕迹:`[vision-bridge: image attached] ...`、系统提示以 `[vision-bridge: vision-hint]` 开头并直言"You cannot see images directly"、已分析占位是 `[vision-bridge: image <id> already analyzed above…]`。按部署要求把**面向模型的注入措辞中性化**,目标是"观感无插件痕迹、读起来像普通引用图片的文本",而非假装模型自己看到图:

- `src/transform.ts`:
  - `imagePromptFor` → `The user attached an image (attachmentId: <id>). Its content is available through the describe_image tool — call it with attachmentId "<id>" ...`(去掉 `[vision-bridge:` 前缀与"You cannot see images directly")。
  - `analyzedPlaceholderFor` → `The attached image (attachmentId: <id>) was already described earlier in this conversation; continue based on that description.`
  - `SYSTEM_HINT_MARKER` 从 `[vision-bridge: vision-hint]` 改为朴素首行 `Attached images are accessible through the describe_image tool.`(它既是幂等锚,又是系统提示的自然首行)。
- **保留**:`describe_image` 工具、`DESCRIBE_IMAGE_RESULT_PREFIX = '[vision-bridge: describe_image ...]'` 工具结果前缀、去重逻辑均不动(它们是机制线,跨 `provider/transform/index` 硬耦合)。
- 测试:同步改 `transform.spec.ts` / `provider.spec.ts` 里对旧 marker 与旧措辞的精确断言。

**边界(现实性)**:**无法做到**"模型以为是它自己识别到的"——上下文里仍有 `describe_image` 工具 schema、图片 block 仍被替换成"经工具取描述"的指令文本、描述结果仍带可解析的 attachmentId 标记。机制就是文本转换,任何诚实且可去重的呈现都绕不开"描述经工具取回"这一事实。中性化只去掉"插件自曝",换来无入侵的观感,并避免在精确读图时把模型推向'自身看到'的自信编造。
