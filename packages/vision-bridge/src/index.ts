/**
 * `@dsh-plugins/vision-bridge`: image understanding for vision-less models.
 *
 * The harness rejects user-uploaded images on routes whose model does not
 * declare `image` input (`UNSUPPORTED_CONTENT` at the adapter). This Consumer
 * plugin bridges that gap without touching the harness: an `llm/stream`
 * waterfall listener rewrites such requests — image blocks become
 * `[vision-bridge: ...]` prompts, a system hint is injected once, and the
 * `describe_image` tool schema is ensured — then re-enters
 * `ctx.llm.stream()` with the transformed request (transformations are
 * idempotent, so the second pass falls through to the adapter). The tool
 * reads the stored attachment from the session log and posts it to the
 * configured OpenAI-compatible vision endpoint for a text description.
 *
 * Routes whose model DOES declare `image` input never see the capability:
 * the same listener strips `describe_image` from their request tools and the
 * tool's execution gate refuses them (`read_image` is the correct tool
 * there). The one exception is a route listed in `Config.bridgeModels`: such
 * a route is forced through the bridge even though it declares `image` —
 * the declaration exists to satisfy the harness Web admission gate, while
 * the endpoint behind it is actually text-only (see the README deployment
 * section). A function/namespace plugin (NOT a default-export service): it
 * registers into existing seams (`ctx.tools`, `ctx.llm`'s waterfall), it
 * owns no `ctx.*` key.
 *
 * @module @dsh-plugins/vision-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import {
  VISION_BRIDGE_DEFAULT_API_KEY_ENV,
  VISION_BRIDGE_DEFAULT_BASE_URL,
  VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT,
  VISION_BRIDGE_DEFAULT_MODEL,
  VISION_BRIDGE_DEFAULT_REASONING_EFFORT,
  applyDescribeImageTool,
  bridgedRouteKey,
  isBridgedRoute,
} from './provider.ts'
import type { VisionBridgeOptions } from './provider.ts'
import { bridgeRequest, stripVisionToolRequest } from './transform.ts'

export {
  DESCRIBE_IMAGE_RESULT_PREFIX,
  DESCRIBE_IMAGE_TOOL_NAME,
  VISION_BRIDGE_DEFAULT_API_KEY_ENV,
  VISION_BRIDGE_DEFAULT_BASE_URL,
  VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT,
  VISION_BRIDGE_DEFAULT_MODEL,
  VISION_BRIDGE_DEFAULT_REASONING_EFFORT,
  applyDescribeImageTool,
  assertBridgedRoute,
  bridgedRouteKey,
  describeImageToolSchema,
  describeImageViaEndpoint,
  isBridgedRoute,
} from './provider.ts'
export type { VisionBridgeOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-bridge'

/** The seams the bridge composes: request waterfall, tool registry, attachment store. */
export const inject = ['llm', 'attachments', 'tools']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal vision API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each analysis; defaults to `Z_AI_API_KEY`. */
  apiKeyEnv?: string
  /** Vision endpoint base; `/chat/completions` is appended. */
  baseURL?: string
  /** Vision model id; defaults to `gemini-3.6-flash`. */
  model?: string
  /** Reasoning strength sent to the vision model (`low|medium|high`); defaults to `low`. */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Instruction sent to the vision model beside the image. */
  describePrompt?: string
  /**
   * Routes forced through the bridge even when they declare `image` input.
   * A deployment whose model metadata over-claims vision — the harness Web
   * admission gate refuses uploads unless the route declares `image`, but the
   * endpoint behind it is text-only (e.g. a DeepSeek route switched to
   * `dsh-llm-pi-ai` with `input: [text, image]`) — lists the route here so
   * the bridge converts its images instead of trusting the declaration.
   * Defaults to no forced routes (a declared-`image` route is served natively).
   */
  bridgeModels?: Array<{ provider: string; model: string }>
  /** Master switch; defaults to `true`. */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry
  // reads there as no value at all.
  apiKeyEnv: z.string().role('credential-ref').default(VISION_BRIDGE_DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  model: z.string(),
  reasoningEffort: z.union(['low', 'medium', 'high'] as const).default(VISION_BRIDGE_DEFAULT_REASONING_EFFORT),
  describePrompt: z.string(),
  bridgeModels: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })),
  enabled: z.boolean().default(true),
})

/**
 * Settings namespace carrying this bridge's endpoint, model, and key
 * reference. `vision-bridge`-owned: no harness card exists for it (the Web
 * settings card allow-list is hardcoded), so configuration travels through
 * the profile patch and environment.
 */
export const VISION_BRIDGE_SETTINGS_NAMESPACE = settingsNamespace('vision-bridge')

/**
 * Project one resolved section into the options the bridge serves its next
 * operation with. Environment fallbacks stay here rather than in the
 * provider: every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one bridge operation.
 */
function resolveOptions(ctx: Context, config: Config): VisionBridgeOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? VISION_BRIDGE_DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    enabled: config.enabled ?? true,
    baseURL: config.baseURL ?? VISION_BRIDGE_DEFAULT_BASE_URL,
    model: config.model ?? VISION_BRIDGE_DEFAULT_MODEL,
    reasoningEffort: config.reasoningEffort ?? VISION_BRIDGE_DEFAULT_REASONING_EFFORT,
    describePrompt: config.describePrompt ?? VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT,
    apiKeyEnv,
    // Normalized once per projection: the same predicate feeds the listener
    // and the tool gate, so a route's forced-bridge status can never drift
    // between the two layers.
    ...config.bridgeModels === undefined || config.bridgeModels.length === 0
      ? {}
      : {
        bridgedRoutes: new Set(config.bridgeModels.map(entry => bridgedRouteKey(entry.provider, entry.model))),
      },
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
  }
}

/**
 * Install the vision bridge: the settings section, the `describe_image` tool,
 * and the `llm/stream` listener that rewrites requests for vision-less
 * routes (and hides the tool from image-capable ones).
 *
 * The listener is a SYNCHRONOUS function returning an async generator (the
 * waterfall is consumed by `for await`, so returning a promise would break
 * it); all async work — modality resolution — happens inside the generator
 * body. Transformations re-enter `ctx.llm.stream()` with a NEW request
 * object (the original is deep-frozen); the transformations are idempotent,
 * so the second entry reports "no change" and falls through to `next()`
 * (see the invariant companion for the static proof of that relation).
 *
 * Failure handling is conservative: when modality resolution fails or the
 * `llm` service is gone, the request passes through untouched — a bridge
 * fault must never block a conversation.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, VISION_BRIDGE_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: options are projected per
    // operation, so a committed change needs no re-registration.
    onChange: () => {},
  })
  applyDescribeImageTool(ctx, () => resolveOptions(ctx, current()))

  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    const snapshot = resolveOptions(ctx, current())
    return (async function* () {
      if (!snapshot.enabled) {
        // Disabled = the bridge is inert: hide the tool from every route and
        // let the request through untouched (same as an uninstalled bridge).
        const stripped = stripVisionToolRequest(options)
        if (stripped === null) {
          yield* next()
          return
        }
        yield* ctx.llm.stream(stripped)
        return
      }
      let info
      try {
        info = await ctx.get('llm')?.resolveModelInfo(options.provider, options.model, options.signal)
      } catch {
        // A bridge fault must not block the conversation: pass through.
        yield* next()
        return
      }
      if (info === undefined) {
        yield* next()
        return
      }
      // A forced-bridge route is converted even when it declares `image`
      // input: the declaration exists to pass the harness Web admission gate,
      // while the endpoint behind it is text-only (see Config.bridgeModels).
      const bridged = isBridgedRoute(snapshot, options.provider, options.model)
      if (!bridged && info.inputModalities !== undefined && info.inputModalities.includes('image')) {
        // Image-capable route: hide the bridge tool; messages stay untouched
        // (the adapter handles images natively).
        const stripped = stripVisionToolRequest(options)
        if (stripped === null) {
          yield* next()
          return
        }
        yield* ctx.llm.stream(stripped)
        return
      }
      // Vision-less route (explicit ['text'] or undeclared modalities —
      // conservative bridging, see README), or a forced-bridge route: replace
      // image blocks, inject the system hint once, ensure the tool schema.
      const transformed = bridgeRequest(options)
      if (transformed === null) {
        yield* next()
        return
      }
      yield* ctx.llm.stream(transformed)
    })()
  }, { global: true, prepend: true })
}
