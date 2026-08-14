/**
 * The `describe_image` tool and the `llm/stream` listener over the real
 * registry: route gates (multimodal refusal, unresolvable route, disabled),
 * session-log attachment resolution, vision-endpoint request shaping,
 * credential resolution, error classification, and the request
 * transformation/re-entry behavior observed at the adapter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as visionBridge from '@dsh-plugins/vision-bridge'
import {
  DESCRIBE_IMAGE_RESULT_PREFIX,
  DESCRIBE_IMAGE_TOOL_NAME,
  VISION_BRIDGE_DEFAULT_BASE_URL,
  VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT,
  VISION_BRIDGE_DEFAULT_MODEL,
  VISION_BRIDGE_DEFAULT_REASONING_EFFORT,
} from '@dsh-plugins/vision-bridge'
import type { SessionEventLike } from '../src/resolve.ts'
import {
  PNG_1X1,
  RecordingAdapter,
  agentOn,
  boot,
  call,
  text,
} from './helpers.ts'

const BASE_URL = 'https://vision.test/v1'

/** The failing-resolve adapter: modality resolution must not block requests. */
class FailingResolveAdapter extends RecordingAdapter {
  override resolveModel(): Promise<never> {
    return Promise.reject(new Error('resolveModel exploded'))
  }
}

let dshHome: string

beforeEach(async () => {
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-vision-bridge-'))
})

afterEach(async () => {
  await rm(dshHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
  delete process.env.Z_AI_API_KEY
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/** The session-log fixture: the saved image inside one user message. */
async function sessionWithImage(
  bench: Awaited<ReturnType<typeof boot>>,
  attachmentId?: string,
): Promise<{ events: SessionEventLike[]; attachmentId: string }> {
  const attachments = bench.ctx.get('attachments')
  if (attachments === undefined) throw new Error('expected the attachment service')
  const ref = await attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  const id = attachmentId ?? String(ref.attachmentId)
  return {
    attachmentId: id,
    events: [{
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'image', attachment: { ...ref, attachmentId: id } }],
        source: { kind: 'user' },
      },
    }],
  }
}

describe('describe_image route gate', () => {
  it('refuses a multimodal route and points to read_image', async () => {
    const bench = await boot({ dshHome })
    const { events } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId: 'any' }, agentOn('vision-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('declares image input')
    expect(text(result)).toContain('read_image')
  })

  it('bridges an undeclared-modality route (conservative bridging, unlike read_image)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a legacy ball' } }] })))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('legacy-model', events))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('a legacy ball')
  })

  it('admits a declared-image route listed in bridgeModels (the declaration is a deployment lie the bridge serves)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a bridged ball' } }] })))
    const bench = await boot({
      dshHome,
      config: {
        apiKey: 'k',
        bridgeModels: [{ provider: 'visual', model: 'vision-model' }],
      },
    })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('vision-model', events))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('a bridged ball')
  })

  it('refuses when the route cannot be resolved', async () => {
    const bench = await boot({ dshHome })
    const { events, attachmentId } = await sessionWithImage(bench)
    const noAgent = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId })
    expect(noAgent.isError).toBe(true)
    expect(text(noAgent)).toContain('route could not be resolved')

    const noRoute = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, {
      options: {},
      session: { requestHeader: () => undefined },
    })
    expect(noRoute.isError).toBe(true)
    expect(text(noRoute)).toContain('route could not be resolved')
    expect(events.length).toBeGreaterThan(0)
  })

  it('refuses while the bridge is disabled', async () => {
    const bench = await boot({ dshHome, config: { enabled: false, apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('vision-bridge.enabled is false')
  })

  it('rejects a blank attachmentId before any lookup', async () => {
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId: '   ' }, agentOn('text-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('non-empty')
  })

  it('refuses an attachment id absent from the session log', async () => {
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId: 'sha256:unknown' }, agentOn('text-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no image attachment with this id in the session log')
  })
})

describe('describe_image happy path', () => {
  it('posts the stored image to the vision endpoint and returns the description', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a red ball on a table' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const bench = await boot({ dshHome, config: { baseURL: BASE_URL, apiKey: 'vb-key' } })
    const { events, attachmentId } = await sessionWithImage(bench)

    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`${DESCRIBE_IMAGE_RESULT_PREFIX}${attachmentId}] a red ball on a table`)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}/chat/completions`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer vb-key')
    expect(headers['user-agent']).toBe('deepseek-harness/0.1.0')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(VISION_BRIDGE_DEFAULT_MODEL)
    expect(body.reasoning_effort).toBe(VISION_BRIDGE_DEFAULT_REASONING_EFFORT)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: VISION_BRIDGE_DEFAULT_DESCRIBE_PROMPT })
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
  })

  it('carries a configured reasoningEffort into the request body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a calm ball' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const bench = await boot({ dshHome, config: { apiKey: 'vb-key', reasoningEffort: 'high' } })
    const { events, attachmentId } = await sessionWithImage(bench)

    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))

    expect(result.isError).toBe(false)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${VISION_BRIDGE_DEFAULT_BASE_URL}/chat/completions`)
    const body = JSON.parse(init.body as string)
    expect(body.reasoning_effort).toBe('high')
  })

  it('falls back to $Z_AI_API_KEY and the default endpoint when config omits them', async () => {
    process.env.Z_AI_API_KEY = 'env-key'
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const bench = await boot({ dshHome })
    const { events, attachmentId } = await sessionWithImage(bench)

    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))

    expect(result.isError).toBe(false)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://10.66.66.66:8080/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer env-key')
  })

  it('forwards the execution abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const controller = new AbortController()
    await bench.ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('bridge-ctrl'),
      name: DESCRIBE_IMAGE_TOOL_NAME,
      arguments: { attachmentId },
      agent: agentOn('text-model', events) as never,
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('describe_image error classification', () => {
  it('fails naming the credential reference when no layer supplies a key', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const bench = await boot({ dshHome })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Z_AI_API_KEY')
  })

  it('surfaces an HTTP error with the endpoint detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, { status: 401 })))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('HTTP 401')
    expect(text(result)).toContain('bad key')
  })

  it('keeps the status line when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('describe_image endpoint error (HTTP 502)')
  })

  it('maps an unparseable success body to a classified error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unprocessable response body')
  })

  it('rejects a well-formed body without a usable description', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [] })))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no usable description')
  })

  it('classifies a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('describe_image request failed')
  })

  it('classifies an abort as describe_image aborted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    const { events, attachmentId } = await sessionWithImage(bench)
    const result = await call(bench.ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId }, agentOn('text-model', events))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('describe_image aborted')
  })
})

describe('llm/stream listener request transformation', () => {
  const imageMessage = () => [{
    id: 'msg-img',
    role: 'user',
    content: [{
      type: 'image',
      attachment: {
        attachmentId: 'sha256:listener-img',
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
      },
    }],
    source: { kind: 'user' },
  }] as unknown as GenerateOptions['messages']

  async function streamToAdapter(
    bench: Awaited<ReturnType<typeof boot>>,
    options: GenerateOptions,
  ): Promise<void> {
    for await (const _chunk of bench.ctx.llm.stream(options)) {
      // drain
    }
  }

  it('bridges an image-carrying request for a vision-less model', async () => {
    const bench = await boot({ dshHome })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: imageMessage(),
      system: 'base prompt',
      tools: [{ name: 'other', description: 'd', parameters: {} }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent).not.toBe(options)
    expect(sent.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(false)
    expect(sent.system).toContain('Attached images are accessible through the describe_image tool.')
    expect(sent.system).toContain('base prompt')
    expect(sent.tools!.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)).toBe(true)
    expect(sent.tools!.some(tool => tool.name === 'other')).toBe(true)
    expect(sent.provider).toBe('visual')
    expect(sent.model).toBe('text-model')
  })

  it('injects the hint and tool into a vision-less request even without images', async () => {
    const bench = await boot({ dshHome })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent.messages).toBe(options.messages)
    expect(sent.system).toContain('Attached images are accessible through the describe_image tool.')
    expect(sent.tools!.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)).toBe(true)
  })

  it('passes an already-bridged request through unchanged (the re-entry termination case)', async () => {
    const bench = await boot({ dshHome })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      system: 'Attached images are accessible through the describe_image tool.\nWhen a message references an image by attachmentId, call the describe_image tool.',
      tools: [{ name: DESCRIBE_IMAGE_TOOL_NAME, description: 'd', parameters: {} }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    expect(bench.adapter.requests[0]).toBe(options)
  })

  it('strips the bridge tool from a multimodal route and keeps messages untouched', async () => {
    const bench = await boot({ dshHome })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'vision-model',
      messages: imageMessage(),
      tools: [{ name: 'other', description: 'd', parameters: {} }, { name: DESCRIBE_IMAGE_TOOL_NAME, description: 'd', parameters: {} }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent).not.toBe(options)
    expect(sent.messages).toBe(options.messages)
    expect(sent.system).toBeUndefined()
    expect(sent.tools).toEqual([{ name: 'other', description: 'd', parameters: {} }])
    expect(sent.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(true)
  })

  it('passes a multimodal request without the bridge tool through unchanged', async () => {
    const bench = await boot({ dshHome })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'vision-model',
      messages: imageMessage(),
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    expect(bench.adapter.requests[0]).toBe(options)
  })

  it('bridges a declared-image route listed in bridgeModels instead of stripping the tool', async () => {
    const bench = await boot({
      dshHome,
      config: { bridgeModels: [{ provider: 'visual', model: 'vision-model' }] },
    })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'vision-model',
      messages: imageMessage(),
      system: 'base prompt',
      tools: [{ name: 'other', description: 'd', parameters: {} }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent).not.toBe(options)
    // The image block is converted to a bridge prompt, the hint is injected,
    // and describe_image is ensured — exactly the vision-less treatment.
    expect(sent.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(false)
    expect(sent.system).toContain('Attached images are accessible through the describe_image tool.')
    expect(sent.system).toContain('base prompt')
    expect(sent.tools!.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)).toBe(true)
    expect(sent.tools!.some(tool => tool.name === 'other')).toBe(true)
  })

  it('bridges a vision-less route listed in bridgeModels the same as any other vision-less route', async () => {
    const bench = await boot({
      dshHome,
      config: { bridgeModels: [{ provider: 'visual', model: 'text-model' }] },
    })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: imageMessage(),
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(false)
    expect(sent.tools!.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)).toBe(true)
  })

  it('strips the tool and leaves messages untouched while disabled', async () => {
    const bench = await boot({ dshHome, config: { enabled: false } })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: imageMessage(),
      tools: [{ name: DESCRIBE_IMAGE_TOOL_NAME, description: 'd', parameters: {} }],
    }
    await streamToAdapter(bench, options)

    expect(bench.adapter.requests).toHaveLength(1)
    const sent = bench.adapter.requests[0]!
    expect(sent.tools).toEqual([])
    expect(sent.messages).toBe(options.messages)
  })

  it('passes through when modality resolution fails (a bridge fault never blocks a conversation)', async () => {
    const bench = await boot({ dshHome, adapter: new FailingResolveAdapter() })
    const options: GenerateOptions = {
      provider: 'visual',
      model: 'text-model',
      messages: imageMessage(),
    }
    const chunks: unknown[] = []
    for await (const chunk of bench.ctx.llm.stream(options)) chunks.push(chunk)

    // The listener must fall through to the chain: the downstream adapter
    // boundary turns the adapter's own resolution failure into a terminal
    // error finish chunk (the request is never transformed, and the stream
    // still terminates instead of hanging).
    expect(bench.adapter.requests).toHaveLength(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })
})

describe('vision-bridge registration surface', () => {
  it('registers describe_image and withdraws it on dispose (HMR-safe)', async () => {
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    expect(bench.ctx.tools.get(DESCRIBE_IMAGE_TOOL_NAME)).toBeDefined()
    expect(bench.ctx.tools.schemas().map(schema => schema.name)).toContain(DESCRIBE_IMAGE_TOOL_NAME)

    await bench.fiber.dispose()

    expect(bench.ctx.tools.get(DESCRIBE_IMAGE_TOOL_NAME)).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('declares describe_image parallel-safe', async () => {
    const bench = await boot({ dshHome, config: { apiKey: 'k' } })
    expect(bench.ctx.tools.executionMode({
      signal: new AbortController().signal,
      callId: 'bridge-parallel' as never,
      name: DESCRIBE_IMAGE_TOOL_NAME,
      arguments: { attachmentId: 'sha256:x' },
    })).toEqual({ kind: 'parallel' })
    await bench.ctx.fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in visionBridge).toBe(false)
  })
})
