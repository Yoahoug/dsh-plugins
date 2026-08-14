/**
 * Pure request-transformation functions for the vision bridge.
 *
 * The `llm/stream` listener cannot mutate its (deep-frozen) request, so it
 * builds a NEW request and re-enters `ctx.llm.stream()`. Every function here
 * is idempotent: applying it to an already-transformed request reports "no
 * change" (`null` / the same reference), which is exactly what makes the
 * re-entry terminate — the second pass through the listener falls through to
 * `next()` instead of re-entering again. The package invariant companion
 * checks these data relations statically.
 *
 * @module @dsh-plugins/vision-bridge/transform
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  DESCRIBE_IMAGE_RESULT_PREFIX,
  DESCRIBE_IMAGE_TOOL_NAME,
  describeImageToolSchema,
} from './provider.ts'

/**
 * Marker line anchoring system-prompt injection idempotency: once the hint
 * text contains this line, `injectSystemHint` reports no change. The marker is
 * deliberately plain and model-facing (not a plugin-namespaced tag): it doubles
 * as the hint's natural first line, so the injected prompt reads neutrally to
 * the model rather than exposing the integration.
 */
export const SYSTEM_HINT_MARKER = 'Attached images are accessible through the describe_image tool.'

/**
 * Replace one user-uploaded image block with the model-facing prompt that
 * tells a vision-less model to fetch the description through the
 * `describe_image` tool. The `attachmentId` is quoted verbatim so the model
 * can copy it into the tool argument.
 * @param attachmentId - the image's content-addressed attachment id.
 * @returns the replacement text block content.
 */
export function imagePromptFor(attachmentId: string): string {
  return `The user attached an image (attachmentId: ${attachmentId}). Its content is available through the describe_image tool — call it with attachmentId "${attachmentId}" to get the image's text description, then answer based on it.`
}

/**
 * Short placeholder replacing an image block whose `attachmentId` already has
 * a `describe_image` result earlier in the conversation: re-prompting the
 * model to re-analyze the same image would waste a vision round-trip.
 * @param attachmentId - the already-analyzed image's attachment id.
 * @returns the placeholder text block content.
 */
export function analyzedPlaceholderFor(attachmentId: string): string {
  return `The attached image (attachmentId: ${attachmentId}) was already described earlier in this conversation; continue based on that description.`
}

/**
 * The system-prompt paragraph injected once into vision-less routes. Its
 * first line is the {@link SYSTEM_HINT_MARKER} idempotency anchor.
 * @returns the full hint paragraph.
 */
export function systemHint(): string {
  return `${SYSTEM_HINT_MARKER}
When a message references an image by attachmentId, call the describe_image tool with that exact attachmentId to get the image's text description, then continue based on it.`
}

/**
 * Append the vision hint to a system prompt exactly once. The marker line
 * makes the operation idempotent: a system prompt that already contains it is
 * returned unchanged (same reference).
 * @param system - the current system prompt, or `undefined` for a system-less request.
 * @returns the prompt with the hint appended; a system-less request gains the hint alone.
 */
export function injectSystemHint(system: string | undefined): string {
  if (system !== undefined && system.includes(SYSTEM_HINT_MARKER)) return system
  return system === undefined ? systemHint() : `${system}\n\n${systemHint()}`
}

/**
 * Collect every attachment id that already has a `describe_image` result in
 * the conversation, so re-attached images degrade to a placeholder instead of
 * a fresh prompt. Matches the `[vision-bridge: describe_image <id>]` prefix
 * the tool's renderer emits (see `provider.ts`); index-based parsing keeps one
 * source of truth for the prefix.
 * @param messages - the request's message list.
 * @returns the set of analyzed attachment ids.
 */
export function collectAnalyzedIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) collectAnalyzedFromBlocks(message.content, ids)
  return ids
}

/** Scan one content-block list for describe_image result markers, recursing into tool results. */
function collectAnalyzedFromBlocks(blocks: readonly ContentBlock[], ids: Set<string>): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      let from = 0
      for (;;) {
        const start = block.text.indexOf(DESCRIBE_IMAGE_RESULT_PREFIX, from)
        if (start < 0) break
        const close = block.text.indexOf(']', start + DESCRIBE_IMAGE_RESULT_PREFIX.length)
        if (close < 0) break
        const id = block.text.slice(start + DESCRIBE_IMAGE_RESULT_PREFIX.length, close).trim()
        if (id.length > 0) ids.add(id)
        from = close + 1
      }
    } else if (block.type === 'tool-result') {
      collectAnalyzedFromBlocks(block.content, ids)
    }
  }
}

/**
 * Replace every `image` block of one content list (recursing into tool-result
 * content) with prompt or placeholder text, preserving every other block.
 * @param blocks - the content blocks to scan.
 * @param analyzed - attachment ids that already have a description in history.
 * @returns the replacement list, or `null` when no block changed.
 */
export function transformBlocks(
  blocks: readonly ContentBlock[],
  analyzed: ReadonlySet<string>,
): ContentBlock[] | null {
  let changed = false
  const out = blocks.map((block): ContentBlock => {
    if (block.type === 'image') {
      changed = true
      const id = String(block.attachment.attachmentId)
      return analyzed.has(id)
        ? { type: 'text', text: analyzedPlaceholderFor(id) }
        : { type: 'text', text: imagePromptFor(id) }
    }
    if (block.type === 'tool-result') {
      const nested = transformBlocks(block.content, analyzed)
      if (nested === null) return block
      changed = true
      return { ...block, content: nested }
    }
    return block
  })
  return changed ? out : null
}

/**
 * Transform one message list for a vision-less route: replace image blocks
 * (prompt, or placeholder when already analyzed). Message identity, role, and
 * source survive; only the content array is rebuilt.
 * @param messages - the request's message list.
 * @returns the replacement list, or `null` when no message changed.
 */
export function transformMessages(messages: readonly Message[]): Message[] | null {
  const analyzed = collectAnalyzedIds(messages)
  let changed = false
  const out = messages.map((message): Message => {
    const blocks = transformBlocks(message.content, analyzed)
    if (blocks === null) return message
    changed = true
    return { ...message, content: blocks }
  })
  return changed ? out : null
}

/**
 * Add the `describe_image` schema to a request's tools exactly once. Returns
 * the same array when the tool is already present (idempotent); the registry
 * normally assembles it anyway, this is the correctness net for requests that
 * bypass prompt assembly.
 * @param tools - the request's tool schemas, or `undefined`.
 * @returns the tools with the schema present, or `undefined` for a tool-less
 *   request that gains the bridge tool alone.
 */
export function ensureDescribeImageTool(tools: ToolSchema[] | undefined): ToolSchema[] | undefined {
  if (tools !== undefined && tools.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)) return tools
  const schema = describeImageToolSchema()
  return tools === undefined ? [schema] : [...tools, schema]
}

/**
 * Remove the `describe_image` schema from a request's tools (multimodal
 * routes and the disabled state). Returns the same array when the tool is
 * already absent (idempotent).
 * @param tools - the request's tool schemas, or `undefined`.
 * @returns the tools without the schema, or `undefined` unchanged.
 */
export function stripDescribeImageTool(tools: ToolSchema[] | undefined): ToolSchema[] | undefined {
  if (tools === undefined || !tools.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)) return tools
  return tools.filter(tool => tool.name !== DESCRIBE_IMAGE_TOOL_NAME)
}

/**
 * Build the vision-less route's request: image blocks replaced, system hint
 * injected once, `describe_image` ensured. `null` means nothing needed
 * changing — the caller falls through to `next()` (this is the re-entry
 * termination condition).
 * @param options - the original (frozen) request.
 * @returns a replacement request, or `null` for "no change".
 */
export function bridgeRequest(options: GenerateOptions): GenerateOptions | null {
  const messages = transformMessages(options.messages)
  const system = injectSystemHint(options.system)
  const tools = ensureDescribeImageTool(options.tools)
  const messagesChanged = messages !== null
  const systemChanged = system !== options.system
  const toolsChanged = tools !== options.tools
  if (!messagesChanged && !systemChanged && !toolsChanged) return null
  // Each changed branch is non-undefined by construction: transformMessages
  // returns an array only when something changed, injectSystemHint always
  // returns a string, and ensureDescribeImageTool returns a fresh array
  // whenever the tools did change.
  return {
    ...options,
    ...messagesChanged ? { messages: messages! } : {},
    ...systemChanged ? { system } : {},
    ...toolsChanged ? { tools: tools! } : {},
  }
}

/**
 * Build the multimodal/disabled route's request: only the `describe_image`
 * tool schema is stripped; messages and system prompt stay untouched. `null`
 * means the tool was already absent — the caller falls through to `next()`.
 * @param options - the original (frozen) request.
 * @returns a replacement request, or `null` for "no change".
 */
export function stripVisionToolRequest(options: GenerateOptions): GenerateOptions | null {
  const tools = stripDescribeImageTool(options.tools)
  if (tools === options.tools || tools === undefined) return null
  return { ...options, tools }
}
