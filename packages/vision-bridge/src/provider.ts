/**
 * The vision bridge's model-facing tool and vision-endpoint client.
 *
 * `describe_image` is the second line of defense for the bridge: the
 * `llm/stream` listener hides the tool from image-capable routes at the schema
 * level, and this tool re-checks the calling route at execution time and
 * refuses multimodal models (they should use `read_image` instead). Execution
 * resolves the full attachment reference from the session log, reads the
 * stored bytes, and posts them to the configured OpenAI-compatible vision
 * endpoint (`POST {baseURL}/chat/completions`) with the credential carried as
 * `Bearer`, `redirect: 'error'` (credentials never cross origins), and a
 * harness user-agent.
 *
 * @module @dsh-plugins/vision-bridge/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findImageAttachmentRef, routeOf } from './resolve.ts'
import type { ExecutionLike } from './resolve.ts'
import type { VisionChatCompletionRequest, VisionChatCompletionResponse } from './types.ts'

/** The tool name the bridge registers and injects into vision-less requests. */
export const DESCRIBE_IMAGE_TOOL_NAME = 'describe_image'

/**
 * The model-facing result prefix marking one `describe_image` outcome. The
 * request transformer scans history for this prefix to decide which images
 * are "already analyzed" — keep it in sync with the renderer below.
 */
export const DESCRIBE_IMAGE_RESULT_PREFIX = '[vision-bridge: describe_image '

/** Default vision endpoint (same origin as the opencode zai-vision MCP / codex provider). */
export const VISION_BRIDGE_DEFAULT_BASE_URL = 'http://10.66.66.66:8080/v1'

/** Default vision model id. Matches the opencode `zai-vision` MCP default (`Z_AI_VISION_MODEL=gemini-3.6-flash`). */
export const VISION_BRIDGE_DEFAULT_MODEL = 'gemini-3.6-flash'

/** Default reasoning strength sent to vision models that support it (OpenAI-style `low|medium|high`). */
export const VISION_BRIDGE_DEFAULT_REASONING_EFFORT = 'low'

/** Default credential reference (matches the opencode zai-vision MCP environment variable). */
export const VISION_BRIDGE_DEFAULT_API_KEY_ENV = 'Z_AI_API_KEY'

/** Default instruction sent to the vision model beside the image. */
export const VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT =
  'Describe this image in detail, including any visible text, so that a model which cannot see the image can answer questions about it.'

/** Attribution header sent on every request. Bump with the package version. */
export const USER_AGENT = 'deepseek-harness/0.1.0'

/** Model-facing description of the `describe_image` tool (shared by registry and request schema). */
const DESCRIBE_IMAGE_TOOL_DESCRIPTION =
  'Describe an image the user attached to this session (by attachmentId) and return its text description. Use this only when the current model cannot see images directly.'

/** Resolved bridge options (the plugin's `apply` supplies credential and constant defaults). */
export interface VisionBridgeOptions {
  /** Master switch: when false the bridge is inert and the tool refuses calls. */
  enabled: boolean
  /** Vision endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Vision model id sent in the chat-completion request. */
  model: string
  /** Reasoning strength sent to vision models that support it (`low|medium|high`); omitted when unset. */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv: CredentialRef
  /** Instruction sent to the vision model beside the image. */
  describePrompt: string
  /**
   * Routes forced through the bridge even when they declare `image` input
   * (`${provider}/${model}` keys). A deployment whose model metadata
   * over-claims vision — the route must declare `image` or the harness Web
   * gate refuses the upload, but the actual endpoint is text-only — lists the
   * route here so the bridge converts images instead of trusting the
   * declaration. See the README deployment section.
   */
  bridgedRoutes?: ReadonlySet<string>
  /** Literal vision API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current vision API key for one analysis. */
  resolveApiKey?: () => Promise<string | undefined>
}

/** The canonical key of one routed provider/model pair in {@link VisionBridgeOptions.bridgedRoutes}. */
export function bridgedRouteKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Whether one routed provider/model pair is forced through the bridge by the
 * deployment, regardless of its declared modalities. The same predicate feeds
 * the `llm/stream` listener (convert the request) and the tool's execution
 * gate (admit the call), so a bridged route can never be refused at one layer
 * and converted at the other.
 * @param options - the operation's option snapshot.
 * @param provider - the routed provider id.
 * @param model - the routed model id.
 * @returns true when the route is listed in `bridgedRoutes`.
 */
export function isBridgedRoute(options: VisionBridgeOptions, provider: string, model: string): boolean {
  return options.bridgedRoutes !== undefined && options.bridgedRoutes.has(bridgedRouteKey(provider, model))
}

/**
 * The `describe_image` tool schema as injected into request `tools` (the
 * registry assembles its own copy from the `defineTool` declaration; this is
 * the hand-compiled equivalent the request transformer uses as its
 * correctness net).
 * @returns the schema sent to the model.
 */
export function describeImageToolSchema(): ToolSchema {
  return {
    name: DESCRIBE_IMAGE_TOOL_NAME,
    description: DESCRIBE_IMAGE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          description: 'Attachment id of the uploaded image, exactly as written in the [vision-bridge: ...] prompt.',
        },
      },
      required: ['attachmentId'],
    },
  }
}

/** The model-facing result prefix for one analyzed image. */
function describeResultPrefixFor(attachmentId: string): string {
  return `${DESCRIBE_IMAGE_RESULT_PREFIX}${attachmentId}]`
}

/**
 * Register the `describe_image` tool into the given context. Options are read
 * per execution through the thunk (the plugin snapshots its settings section
 * per operation), so a settings change needs no re-registration.
 * @param ctx - the registration scope; execution uses the optional
 *   `llm`/`attachments` services.
 * @param resolveOptions - the options for the NEXT execution.
 */
export function applyDescribeImageTool(ctx: Context, resolveOptions: () => VisionBridgeOptions): void {
  ctx.tools.register(defineTool({
    name: DESCRIBE_IMAGE_TOOL_NAME,
    description: DESCRIBE_IMAGE_TOOL_DESCRIPTION,
    parameters: {
      attachmentId: {
        type: 'string',
        required: true,
        description: 'Attachment id of the uploaded image, exactly as written in the [vision-bridge: ...] prompt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${describeResultPrefixFor(args.attachmentId)} ${value.description}`,
      }],
    },
    // Reads only: the same image may be analyzed concurrently and duplicate
    // analyses are harmless (there is no process-local cache yet).
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const attachmentId = args.attachmentId.trim()
      if (attachmentId.length === 0) throw new Error('attachmentId must be a non-empty string')
      const options = resolveOptions()
      if (!options.enabled) {
        throw new Error('describe_image is disabled: vision-bridge.enabled is false')
      }
      await assertBridgedRoute(ctx, exec, attachmentId, options)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot describe image "${attachmentId}": no attachment service is mounted`)
      }
      // The log is the only source of a complete, storage-consistent
      // reference: readImage verifies bytes AND metadata, so the ref must
      // come from the session, never from model-restated values.
      const ref = findImageAttachmentRef(exec.agent?.session?.events, attachmentId)
      if (ref === undefined) {
        throw new Error(`cannot describe image "${attachmentId}": no image attachment with this id in the session log`)
      }
      const stored = await attachments.readImage(ref, exec.signal)
      const apiKey = options.apiKey ?? await resolveCredential(options)
      const description = await describeImageViaEndpoint(options, apiKey, stored, exec.signal)
      return { description }
    },
  }))
}

/**
 * Enforce the bridge gate for the calling route: the route must resolve and
 * the exact resolved model must NOT declare `image` input — unless the route
 * is listed in {@link VisionBridgeOptions.bridgedRoutes}, whose declaration
 * is a deployment lie the bridge exists to serve (the Web admission gate
 * requires `image`, the endpoint cannot take it). A route that resolves to a
 * genuinely image-capable model is refused with a pointer to `read_image`; an
 * unresolvable route is refused (unknown capability is not bridged — the same
 * philosophy as `read_image`'s strict gate).
 * @param ctx - the plugin context used to resolve the optional `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 * @param attachmentId - the image id rendered in refusal messages.
 * @param options - the operation's option snapshot carrying the forced-bridge list.
 */
export async function assertBridgedRoute(
  ctx: Context,
  exec: ExecutionLike,
  attachmentId: string,
  options: VisionBridgeOptions,
): Promise<void> {
  const { provider, model } = routeOf(exec)
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot describe image "${attachmentId}": the current model route could not be resolved`)
  }
  if (isBridgedRoute(options, provider, model)) return
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities !== undefined && active.inputModalities.includes('image')) {
    throw new Error(`cannot describe image "${attachmentId}": model "${model}" declares image input; use read_image instead of describe_image`)
  }
}

/**
 * Resolve the vision API key through the bridge's credential resolver, or
 * fail with the named reference so the operator knows which credential to
 * store.
 * @param options - the operation's option snapshot.
 * @returns the resolved key.
 * @throws when no layer supplies a key.
 */
async function resolveCredential(options: VisionBridgeOptions): Promise<string> {
  if (options.resolveApiKey === undefined) throw missingKeyError(options.apiKeyEnv)
  try {
    const key = await options.resolveApiKey()
    if (key !== undefined && key.length > 0) return key
  } catch (error: unknown) {
    if (isAbortError(error)) throw new Error('describe_image aborted')
    throw new Error(`describe_image credential resolution failed: ${String(error)}`)
  }
  throw missingKeyError(options.apiKeyEnv)
}

/** A missing-key diagnostic naming the reference the operator must fill. */
function missingKeyError(ref: CredentialRef): Error {
  return new Error(
    `describe_image has no API key for "${ref}"; store it through the credentials service`
    + ' or set "apiKey" in the vision-bridge config',
  )
}

/**
 * Call the configured OpenAI-compatible vision endpoint for one stored image
 * and return the model's text description. The image travels as a base64
 * `data:` URL beside the configured describe prompt; HTTP redirects are
 * rejected before any `Location` target is contacted (credentials never cross
 * origins).
 * @param options - the operation's option snapshot (endpoint, model, prompt).
 * @param apiKey - the resolved vision API key.
 * @param stored - the verified image bytes and canonical reference.
 * @param signal - optional cancellation forwarded to the request.
 * @returns the description text from `choices[0].message.content`.
 * @throws an `Error` with a classified message on credential, HTTP,
 *   parse, or shape failure, or an abort.
 */
export async function describeImageViaEndpoint(
  options: VisionBridgeOptions,
  apiKey: string,
  stored: StoredImageAttachment,
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  const body: VisionChatCompletionRequest = {
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: options.describePrompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    ...options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort },
  }
  let response: Response
  try {
    response = await fetch(`${options.baseURL}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    if (isAbortError(error)) throw new Error('describe_image aborted')
    throw new Error(`describe_image request failed: ${String(error)}`)
  }

  if (!response.ok) {
    const status = response.status
    let detail: string | undefined
    try {
      detail = errorDetailOf(await response.json())
    } catch (error: unknown) {
      if (isAbortError(error)) throw new Error('describe_image aborted')
      try {
        const text = (await response.text()).trim()
        detail = text.length > 0 ? text.slice(0, 500) : undefined
      } catch (readError: unknown) {
        if (isAbortError(readError)) throw new Error('describe_image aborted')
      }
    }
    throw new Error(detail === undefined
      ? `describe_image endpoint error (HTTP ${status})`
      : `describe_image endpoint error (HTTP ${status}): ${detail}`)
  }

  let payload: VisionChatCompletionResponse
  try {
    payload = await response.json() as VisionChatCompletionResponse
  } catch (error: unknown) {
    if (isAbortError(error)) throw new Error('describe_image aborted')
    throw new Error(`describe_image returned an unprocessable response body: ${String(error)}`)
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('describe_image endpoint returned no usable description: choices[0].message.content is missing or empty')
  }
  return content
}

/**
 * Best-effort detail extraction from an OpenAI-compatible error envelope
 * (`{error: {message}}`, `{error: "..."}`, or `{message: "..."}`).
 * @param parsed - the parsed error body.
 * @returns the detail, or `undefined` when the body carries none.
 */
function errorDetailOf(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  const message = record.message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
