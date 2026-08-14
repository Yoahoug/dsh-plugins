/**
 * Route resolution and session-log attachment lookup for the vision bridge.
 *
 * Deliberately typed against STRUCTURAL interfaces instead of the
 * `dsh-agent`/`dsh-session` packages: the bridge is a Consumer that only
 * reads `exec.agent.session.requestHeader()` and the session log, so it
 * depends on the shapes, not on those packages (keeping peer dependencies to
 * the seams it actually invokes).
 *
 * @module @dsh-plugins/vision-bridge/resolve
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** The routed provider/model pair, as carried by a request header or agent options. */
export interface RouteCallConfigLike {
  provider?: string
  model?: string
}

/** The part of a session request header the bridge reads. */
export interface RouteHeaderLike {
  config?: RouteCallConfigLike
}

/** The part of a session the bridge reads. */
export interface SessionLike {
  requestHeader?(): RouteHeaderLike | undefined
  /** Append-only event log; `user/message` and `tool/result` events carry content. */
  events?: readonly SessionEventLike[]
}

/** The part of an agent the bridge reads. */
export interface AgentLike {
  options?: RouteCallConfigLike
  session?: SessionLike
}

/** The part of a tool execution the bridge reads. */
export interface ExecutionLike {
  agent?: AgentLike
  signal?: AbortSignal
}

/** One session event, narrowed at the read site by `type`. */
export interface SessionEventLike {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data: unknown
}

/**
 * Resolve the current route from the session's request header, falling back
 * to the agent's static options (the same two-tier resolution `read_image`
 * uses). A request header that exists wins even when it lacks a field.
 * @param exec - the tool execution supplying the calling agent.
 * @returns the resolved provider and model, either possibly absent.
 */
export function routeOf(exec: ExecutionLike): RouteCallConfigLike {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const options = exec.agent?.options
  const provider = routed?.provider ?? options?.provider
  const model = routed?.model ?? options?.model
  return {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}

/**
 * Find the complete durable `ImageAttachmentRef` for one attachment id in a
 * session log. The `describe_image` tool receives only the id (copied from
 * the prompt), while `attachments.readImage` requires the full reference
 * (mediaType/bytes/width/height must match the stored object), so the ref is
 * resolved deterministically from the log instead of trusting the model to
 * restate metadata. Searches `user/message` content and `tool/result` content,
 * recursing into nested tool-result blocks.
 * @param events - the session's append-only event log.
 * @param attachmentId - the target image's attachment id.
 * @returns the matching reference, or `undefined` when the log has no such image.
 */
export function findImageAttachmentRef(
  events: readonly SessionEventLike[] | undefined,
  attachmentId: string,
): ImageAttachmentRef | undefined {
  if (events === undefined) return undefined
  for (const event of events) {
    if (event.type === 'user/message') {
      const content = (event.data as { content?: readonly ContentBlock[] }).content
      const found = content === undefined ? undefined : findImageInBlocks(content, attachmentId)
      if (found !== undefined) return found
    } else if (event.type === 'tool/result') {
      const content = (event.data as { message?: { content?: readonly ContentBlock[] } }).message?.content
      const found = content === undefined ? undefined : findImageInBlocks(content, attachmentId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Find one image block by attachment id inside a content-block list, recursing into tool results. */
function findImageInBlocks(blocks: readonly ContentBlock[], attachmentId: string): ImageAttachmentRef | undefined {
  for (const block of blocks) {
    if (block.type === 'image') {
      if (String(block.attachment.attachmentId) === attachmentId) return block.attachment
    } else if (block.type === 'tool-result') {
      const nested = findImageInBlocks(block.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
