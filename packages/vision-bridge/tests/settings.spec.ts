/**
 * The plugin's settings section layered over the composition entry. The
 * section registers under the bridge-owned `vision-bridge` namespace (no
 * harness card exists for it — the Web settings allow-list is hardcoded), so
 * the assertions here pin that namespace and the live re-projection of
 * committed changes into the next execution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as visionBridgePlugin from '@dsh-plugins/vision-bridge'
import {
  DESCRIBE_IMAGE_TOOL_NAME,
  VISION_BRIDGE_SETTINGS_NAMESPACE,
} from '@dsh-plugins/vision-bridge'
import { PNG_1X1, RecordingAdapter, agentOn, call, text } from './helpers.ts'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const VISION_ANSWER = { choices: [{ message: { content: 'a red ball' } }] }

let dshHome: string

beforeEach(async () => {
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-vision-settings-'))
})

afterEach(async () => {
  await rm(dshHome, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new RecordingAdapter())
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  const pluginFiber = ctx.plugin(visionBridgePlugin, { apiKey: 'vb-key', baseURL: 'https://entry.test/v1' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

/**
 * Run one `describe_image` execution and answer the endpoint it reached. A
 * fresh `Response` per call because a body can only be read once, and the
 * call history is cleared because repeated `spyOn` returns the same spy.
 * @param ctx - context whose tools serve the bridge tool.
 * @returns the URL the tool fetched.
 */
async function describeOnce(ctx: Context): Promise<string> {
  const fetchSpy = await runDescribe(ctx)
  return String((fetchSpy.mock.calls.at(-1)?.[0] as URL | string | undefined) ?? '')
}

/**
 * Run one `describe_image` execution and answer the request body it sent to
 * the vision endpoint (the decision inputs the settings section projects).
 * @param ctx - context whose tools serve the bridge tool.
 * @returns the parsed JSON request body.
 */
async function describeOnceBody(ctx: Context): Promise<Record<string, unknown>> {
  const fetchSpy = await runDescribe(ctx)
  const [, init] = fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/**
 * Run one `describe_image` execution with a stubbed endpoint and return the
 * fetch spy, so callers can inspect the request it reached.
 * @param ctx - context whose tools serve the bridge tool.
 * @returns the fetch spy with the completed call history.
 */
async function runDescribe(ctx: Context): ReturnType<typeof vi.spyOn> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(VISION_ANSWER)))
  fetchSpy.mockClear()

  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('expected the attachment service')
  const ref = await attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  const events = [{
    type: 'user/message',
    seq: 1,
    time: 0,
    data: {
      id: 'msg-1',
      role: 'user',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(String(ref.attachmentId)),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }],
      source: { kind: 'user' },
    },
  }]
  const result = await call(ctx, DESCRIBE_IMAGE_TOOL_NAME, { attachmentId: String(ref.attachmentId) }, agentOn('text-model', events))
  expect(result.isError).toBe(false)
  expect(text(result)).toContain('a red ball')
  return fetchSpy
}

describe('vision-bridge settings section', () => {
  it('serves a stored endpoint to the next execution without re-registering', async () => {
    const bench = await boot()
    expect(await describeOnce(bench.ctx)).toBe('https://entry.test/v1/chat/completions')

    await bench.ctx.settings.update(VISION_BRIDGE_SETTINGS_NAMESPACE, {
      baseURL: 'https://stored.test/v1',
    })

    expect(await describeOnce(bench.ctx)).toBe('https://stored.test/v1/chat/completions')
    await bench.ctx.fiber.dispose()
  })

  it('serves a stored reasoningEffort to the next execution without re-registering', async () => {
    const bench = await boot()
    expect((await describeOnceBody(bench.ctx)).reasoning_effort).toBe('low')

    await bench.ctx.settings.update(VISION_BRIDGE_SETTINGS_NAMESPACE, {
      reasoningEffort: 'high',
    })

    expect((await describeOnceBody(bench.ctx)).reasoning_effort).toBe('high')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(VISION_BRIDGE_SETTINGS_NAMESPACE, { apiKey: 'vb-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'vision-bridge')

    expect(JSON.stringify(descriptor)).not.toContain('vb-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(VISION_BRIDGE_SETTINGS_NAMESPACE, {
      baseURL: 'https://stored.test/v1',
    })
    expect(await describeOnce(bench.ctx)).toBe('https://stored.test/v1/chat/completions')

    await bench.settingsFiber.dispose()

    expect(await describeOnce(bench.ctx)).toBe('https://entry.test/v1/chat/completions')
    await bench.ctx.fiber.dispose()
  })

  it('serves a stored bridgeModels list to the execution gate (a declared-image route is admitted)', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(VISION_BRIDGE_SETTINGS_NAMESPACE, {
      bridgeModels: [{ provider: 'visual', model: 'vision-model' }],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse(VISION_ANSWER)))
    fetchSpy.mockClear()

    const attachments = bench.ctx.get('attachments')
    if (attachments === undefined) throw new Error('expected the attachment service')
    const ref = await attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
    const events = [{
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'msg-1',
        role: 'user',
        content: [{
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(String(ref.attachmentId)),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          },
        }],
        source: { kind: 'user' },
      },
    }]
    const result = await call(
      bench.ctx,
      DESCRIBE_IMAGE_TOOL_NAME,
      { attachmentId: String(ref.attachmentId) },
      agentOn('vision-model', events),
    )
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('a red ball')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('vision-bridge')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('vision-bridge')
    await bench.ctx.fiber.dispose()
  })
})
