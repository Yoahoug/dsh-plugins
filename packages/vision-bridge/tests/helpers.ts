/**
 * Shared test harness for the vision bridge: a real Cordis context with the
 * real LLM runtime, tool registry, system prompt, and local attachment store,
 * plus a recording fake adapter and agent/session fixtures.
 */

import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as visionBridgePlugin from '@dsh-plugins/vision-bridge'
import type { SessionEventLike } from '../src/resolve.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

/** A text response the recording adapter streams back. */
export async function* textResponse(text: string): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Exact-route fake adapter recording every request that reaches it. */
export class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly models: LlmModelInfo[] = [
    { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
    { provider: 'visual', id: 'legacy-model', name: 'Legacy' },
  ]) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name ?? model,
      ...found?.inputModalities === undefined ? {} : { inputModalities: [...found.inputModalities] },
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return textResponse('bridge ok')
  }
}

/** Boot the full bridge context over a recording adapter. */
export interface BootOptions {
  models?: LlmModelInfo[]
  adapter?: RecordingAdapter
  dshHome?: string
  config?: Record<string, unknown>
}

export async function boot(options: BootOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LlmRuntime)
  const adapter = options.adapter ?? new RecordingAdapter(options.models)
  ctx.llm.registerAdapter(['visual'], adapter)
  if (options.dshHome !== undefined) {
    await ctx.plugin(LocalAttachmentStore, { dshHome: options.dshHome })
  }
  const fiber = await ctx.plugin(visionBridgePlugin, options.config ?? {})
  return { ctx, adapter, fiber }
}

/** A fake calling agent pinned to one routed provider/model with a session log. */
export function agentOn(model: string, events: readonly SessionEventLike[] = []): object {
  return {
    options: {},
    session: {
      requestHeader: () => ({ config: { provider: 'visual', model } }),
      events,
    },
  }
}

let callCounter = 0

/** Execute one tool through the real registry. */
export function call(ctx: Context, name: string, args: unknown, agent?: object): Promise<{
  content: { type: string; text?: string }[]
  isError: boolean
}> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`bridge-call-${++callCounter}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Join the text blocks of a tool result. */
export function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The image reference the session log fixture carries for one saved image. */
export function imageRef(attachmentId: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: 'image/png',
    bytes: PNG_1X1.length,
    width: 1,
    height: 1,
  }
}
