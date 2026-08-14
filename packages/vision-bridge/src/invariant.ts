/**
 * Package-owned invariant companion for `@dsh-plugins/vision-bridge`.
 *
 * The bridge's request transformations are the data relation that keeps the
 * `llm/stream` re-entry loop terminating: a transformation that is NOT
 * idempotent would re-enter `ctx.llm.stream()` forever. This companion
 * checks that relation statically on samples (pure functions, no timing
 * hazards), and it checks the tool/listener co-existence on every request
 * (the bridge is only useful while `describe_image` is registered — a
 * missing tool while the listener is active would leave bridged prompts
 * pointing at nothing).
 *
 * @module @dsh-plugins/vision-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { DESCRIBE_IMAGE_TOOL_NAME } from './provider.ts'
import {
  ensureDescribeImageTool,
  injectSystemHint,
  SYSTEM_HINT_MARKER,
  transformMessages,
} from './transform.ts'

const PACKAGE_NAME = '@dsh-plugins/vision-bridge'

/** Cordis companion plugin name. */
export const name = 'vision-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** A minimal image block the sample transformation must replace. */
const SAMPLE_IMAGE: ContentBlock = {
  type: 'image',
  attachment: {
    attachmentId: AttachmentId('sha256:invariant-sample'),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  },
}

/** Build the transformation sample: one user message with text, image, and nested tool-result content. */
function buildSample(): ContentBlock[][] {
  return [[
    { type: 'text', text: 'look at this' },
    SAMPLE_IMAGE,
    { type: 'tool-result', toolCallId: CallId('invariant-call'), content: [SAMPLE_IMAGE], isError: false },
  ]]
}

/**
 * Install the bridge's invariant checks. The idempotency checks run once at
 * install (pure functions over samples); the tool-registration check runs
 * per request (the bridge plugin may legitimately load after the companion).
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // 1. transformMessages must replace every image block in one pass and
  //    report "no change" (null) on the second pass — the re-entry
  //    termination condition of the llm/stream listener.
  const sample = buildSample()
  const messages = sample.map(content => createUserMessage({
    content,
    source: { kind: 'user' },
  }))
  const once = transformMessages(messages)
  if (once === null) fail('transformMessages left an image block unreplaced in the sample')
  if (once!.some(message => message.content.some(block => block.type === 'image'))) {
    fail('transformMessages must eliminate every image block in one pass')
  }
  if (transformMessages(once!) !== null) {
    fail('transformMessages must be idempotent: a second pass must report no change (the llm/stream re-entry would not terminate)')
  }

  // 2. System-hint and tool-schema operations are idempotent for the same
  //    reason: applying them twice must be a no-op on the second application.
  const hintOnce = injectSystemHint(undefined)
  if (hintOnce === undefined || !hintOnce.includes(SYSTEM_HINT_MARKER)) {
    fail('injectSystemHint must add the marker line to a system-less request')
  }
  if (injectSystemHint(hintOnce) !== hintOnce) {
    fail('injectSystemHint must be idempotent once the marker line is present')
  }
  const toolsOnce = ensureDescribeImageTool(undefined)
  if (toolsOnce === undefined || !toolsOnce.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)) {
    fail('ensureDescribeImageTool must add the describe_image schema to a tool-less request')
  }
  if (ensureDescribeImageTool(toolsOnce) !== toolsOnce) {
    fail('ensureDescribeImageTool must be idempotent once the schema is present')
  }

  // 3. The tool and the listener co-exist: every request the listener lets
  //    through while describe_image is unregistered would hand the bridged
  //    prompt to a model that cannot act on it.
  ctx.on('llm/stream', (_options, next) => {
    const tools = ctx.get('tools')
    if (tools !== undefined && tools.get(DESCRIBE_IMAGE_TOOL_NAME) === undefined) {
      fail('describe_image is not registered while the vision-bridge listener is active')
    }
    return next()
  }, { global: true, prepend: true })
}, { inject: ['llm'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
