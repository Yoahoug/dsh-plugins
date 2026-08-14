# @dsh-plugins/vision-bridge

English | [中文](README.zh.md)

Image understanding for **vision-less models** in the DeepSeek Harness. The harness rejects user-uploaded images on routes whose model does not declare `image` input (`UNSUPPORTED_CONTENT` at the adapter), so this Consumer plugin bridges the gap without touching the harness: user images are converted to text descriptions by an OpenAI-compatible vision endpoint and handed to the vision-less model.

This is a **Consumer/function plugin** (`inject: ['llm', 'attachments', 'tools']`, no default export): it registers a model-facing tool (`describe_image`) into `ctx.tools` and an `llm/stream` waterfall listener that rewrites requests for vision-less routes. It owns no `ctx.*` key.

## How it works

Every model call passes through the `llm/stream` waterfall before reaching the adapter. The bridge listener resolves the exact route's modalities (`ctx.llm.resolveModelInfo`) and then:

| Route modality | Behavior |
|---|---|
| **Declares `image` input** (multimodal) | The capability is **not exposed**: `describe_image` is stripped from the request's `tools` (schema-level invisibility), messages pass through untouched. A direct tool call is refused at execution (`use read_image instead`). |
| **Declares `image` input AND is listed in `bridgeModels`** | **Forced through the bridge**: the declared modality is a deployment lie (see below) — image blocks are converted to prompts, the hint is injected, `describe_image` is ensured, and the execution gate admits the call. |
| **`['text']` or undeclared** (vision-less) | The request is rewritten: every `image` block becomes a neutral prompt carrying the `attachmentId` ("The user attached an image … its content is available through the `describe_image` tool"); a plain system paragraph is appended once (first line: *"Attached images are accessible through the `describe_image` tool."*); the `describe_image` schema is ensured. The injected text is deliberately non-intrusive — no plugin-namespaced `[vision-bridge: …]` tags reach the model. |
| `resolveModelInfo` fails / `llm` missing | The request passes through untouched — a bridge fault never blocks a conversation. |

The listener cannot mutate the (deep-frozen) request, so it builds a NEW request and **re-enters `ctx.llm.stream()`**. Every transformation is idempotent — the second pass reports "no change" and falls through to the adapter — which is exactly what terminates the re-entry (the package invariant companion checks this relation statically). Images whose `attachmentId` already has a `describe_image` result in history degrade to a short "already described earlier in this conversation" placeholder instead of a fresh prompt (no repeated vision round-trips).

When the model follows the prompt, it calls `describe_image(attachmentId)`. The tool resolves the **full attachment reference from the session log** (never from model-restated metadata — the attachment service verifies bytes *and* metadata), reads the stored bytes, and posts them to the vision endpoint:

```
POST {baseURL}/chat/completions        model: gemini-3.6-flash (default)
Authorization: Bearer <key>            content: [{text: describePrompt},
redirect: 'error' + user-agent        {image_url: {url: data:<mime>;base64,…}}]
reasoning_effort: low (default)        (sent when config sets it)
```

The returned description enters the conversation as `[vision-bridge: describe_image <id>] <description>`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `http://10.66.66.66:8080/v1` | Vision endpoint base; `/chat/completions` is appended. Same origin as the opencode `codex` provider / `zai-vision` MCP. |
| `model` | `gemini-3.6-flash` | Vision model id (same as the opencode `zai-vision` MCP default). |
| `reasoningEffort` | `low` | Reasoning strength sent to the vision model as `reasoning_effort` (`low\|medium\|high`, OpenAI style) — for models that accept it. |
| `apiKeyEnv` | `$Z_AI_API_KEY` | Credential reference resolved per analysis through the credentials service, with the launch environment as fallback. |
| `apiKey` | (unset) | Literal API key; prefer `apiKeyEnv` so no secret enters configuration files. |
| `describePrompt` | built-in English prompt | Instruction sent to the vision model beside the image. |
| `bridgeModels` | `[]` | Routes forced through the bridge even when they declare `image` input: a list of `{provider, model}` pairs. See [DeepSeek deployment](#deepseek-deployment). |
| `enabled` | `true` | Master switch. When `false` the bridge is inert: `describe_image` is hidden from every route and direct calls are refused. |

```yaml
- id: vision-bridge
  name: '@dsh-plugins/vision-bridge'
  config:
    baseURL: http://10.66.66.66:8080/v1
    model: gemini-3.6-flash
    reasoningEffort: low
    apiKeyEnv: Z_AI_API_KEY
```

## DeepSeek deployment

The harness Web gate refuses sending an image on a route whose model does not **declare** `image` input ("当前模型不支持图片,请切换支持图片的模型" / `MODEL_DOES_NOT_SUPPORT_IMAGES`). The official `dsh-llm-deepseek` adapter hardcodes `inputModalities: ['text']` for every model and has no configuration field to change that, so there is no way to "tag" a model in the Web model settings — the DeepSeek models editor only carries id/name/context/maxTokens.

To send images to DeepSeek models (bridged via this plugin):

1. **Serve the route with `dsh-llm-pi-ai`** (already in the Web bundle) instead of `dsh-llm-deepseek`, declaring `input: [text, image]` per model. The pi-ai route is fully configurable from `settings.yaml` (and the Web Models page's custom-provider card); use `compat: {thinkingFormat: deepseek, supportsReasoningEffort: true}` + `reasoningEfforts` to reproduce the DeepSeek wire exactly (`thinking: {type}` + `reasoning_effort`). Disable `llm-deepseek` in the patch (the two adapters cannot both own provider `deepseek-official`). **Name the provider id `deepseek`** — pi-ai auto-detects reasoning models by provider name/URL, and a custom id like `deepseek-official` resolves `supportsDeveloperRole: true`, making the adapter serialize the system prompt as role `developer`, which OpenAI-compatible gateways that only accept `system|user|assistant|tool|latest_reminder` reject with 400 `unknown variant 'developer'` (see docs/vision-bridge-development.md §8.4).
2. **List the route in `bridgeModels`** — the declaration in step 1 exists only to pass the Web gate; the endpoint behind it still cannot take image content, so the bridge must convert images for exactly those routes. Without this, the request would be handed to the adapter with real `image` blocks and fail.
3. Mount the bridge as usual (patch insert above) and keep `Z_AI_API_KEY` exported.

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

## Settings namespace

The settings section registers under the **`vision-bridge`** namespace (bridge-owned). The Web settings card and the apiproxy settings allow-list hardcode their namespaces, so **no UI card exists for this section** — configure through the profile patch and the environment (`export Z_AI_API_KEY=…`), exactly like the opencode zai-vision MCP. Committed section changes are projected into the next operation without re-registration.

## Model Experience

The vision-less model sees, on every request: a neutral system paragraph ("Attached images are accessible through the `describe_image` tool."), the `describe_image` tool schema, and slightly reworded "The user attached an image (attachmentId: …)" prompts in place of image blocks — it never receives image tokens, and the adapter's `UNSUPPORTED_CONTENT` rejection never fires. The injection is deliberately non-intrusive: no plugin-namespaced tags reach the model, so the conversation reads like ordinary image-referencing text rather than an integration patch.

- **Tokens**: each bridged image costs the ~50-token prompt text plus the description tool result (typically 50–300 tokens, growing with image complexity). The vision endpoint's own generation is billed outside the conversation model. The system hint is re-injected per request (it is not a registered system-prompt section), which is cache-friendly — see below.
- **KV cache**: the system hint and tool schema form a stable request prefix on a given route, so repeated requests keep cache hits; per-image prompts vary by `attachmentId`. The description enters history once and is reused via the analyzed-placeholder, so no re-analysis tokens are spent on the same image.
- **Failures**: missing credential names the reference (`no API key for "Z_AI_API_KEY"`), HTTP errors carry status + endpoint detail, unparseable bodies and missing `choices[0].message.content` are classified, and aborts surface as `describe_image aborted`.

## Invariant companion

`@dsh-plugins/vision-bridge/invariant` registers two checks: (1) `transformMessages`/`injectSystemHint`/`ensureDescribeImageTool` are idempotent over samples — the static evidence that the `llm/stream` re-entry terminates; (2) every request reaching the listener while `describe_image` is unregistered fails (tool and listener live and die together).

## Known Limitations and Deferred Work

- **`describe_image` accepts only `attachmentId`** (user-uploaded images). Filesystem paths are unsupported — a `file_path` parameter (read_image-style resolution) is deferred.
- **No description cache**: the same image is re-analyzed on every call (vision latency counts into tool execution time). An LRU keyed by `attachmentId` is deferred.
- **Prompts regenerate from the immutable log per request**; the `[vision-bridge` hints themselves are not persisted — the analyzed-placeholder is what suppresses repeat prompts.
- **Undeclared modalities are bridged conservatively**: `inputModalities: undefined` routes are treated as vision-less (the opposite of `read_image`'s conservative refusal) because refusing guarantees the image request fails, while bridging at least works.
- **Global listener**: sub-agent/sub-session requests are transformed too; their session logs are equally searchable for attachment references.
- **Scope-filtered tool restrictions are bypassed at the request layer**: a deployment that scope-restricts `describe_image` will still see the schema re-injected on text-only routes (scope filters do not reach `llm/stream`); registry-level denial still applies at call time.
- **No web settings card** (hardcoded allow-list, see above).
