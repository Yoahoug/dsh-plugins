import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TAVILY_PROVIDER_ID, TavilySearchProvider } from '@dsh-plugins/web-search-tavily'
import type { TavilySearchProviderOptions } from '@dsh-plugins/web-search-tavily'
import * as tavilyPlugin from '@dsh-plugins/web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

const options = {
  apiKey: 'tv-key',
  baseURL: 'https://api.tavily.test',
  searchDepth: 'basic' as const,
  maxResults: 5,
  includeAnswer: true,
}

const provider = (overrides: Partial<TavilySearchProviderOptions> = {}): TavilySearchProvider =>
  new TavilySearchProvider(() => ({ ...options, ...overrides }))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry, trimming the content excerpt', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: '  salient excerpt  ',
      published_date: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient excerpt', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable content', () => {
    expect(mapTavilyResult({ url: 'https://a.test', content: undefined })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test', content: '   ' })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test', content: '' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: null, published_date: null, content: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapTavilyResult({ url: 'https://a.test', title: '', published_date: '', content: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps the generated answer to content and filters snippet-less entries', () => {
    const result = mapTavilyResponse({
      answer: '  A synthesized answer.  ',
      results: [
        { url: 'https://a.test', content: 'one' },
        { url: 'https://b.test' },
        { url: 'https://c.test', title: 'C', content: 'three', published_date: '2026-02-02' },
      ],
    })
    expect(result).toEqual({
      content: 'A synthesized answer.',
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three', publishedAt: '2026-02-02' },
      ],
      truncated: false,
    })
  })

  it('omits content when the answer is absent or blank', () => {
    expect(mapTavilyResponse({ results: [{ url: 'https://a.test', content: 'one' }] }).content).toBeUndefined()
    expect(mapTavilyResponse({ answer: '   ', results: [{ url: 'https://a.test', content: 'one' }] }).content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({}).sources).toEqual([])
  })
})

describe('TavilySearchProvider availability', () => {
  it('is unavailable without a key or key resolver', () => {
    expect(provider({ apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(provider(options).available()).toBe(true)
  })

  it('is available with only a key resolver', () => {
    const resolve = provider({ apiKey: undefined, resolveApiKey: async () => 'resolved-key' })
    expect(resolve.available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxResults is not a positive integer', () => {
    expect(provider({ maxResults: 0 }).available()).toBe(false)
    expect(provider({ maxResults: 1.5 }).available()).toBe(false)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends query, depth, answer flag, max_results and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const subject = provider({ searchDepth: 'advanced', includeAnswer: false })
    await subject.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tv-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      search_depth: 'advanced',
      include_answer: false,
      max_results: 5,
    })
  })

  it('falls back to the configured maxResults when a request omits it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ maxResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 7 })
  })

  it('lets a request maxResults win over the configured default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ maxResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 2 })
  })

  it('resolves the key through the resolver when no literal key is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    await provider({ apiKey: undefined, resolveApiKey }).search({ query: 'q' })
    expect(resolveApiKey).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer resolved-key')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('TavilySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a credential-resolution abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const resolveApiKey = vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    await expect(provider({ apiKey: undefined, resolveApiKey }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('fails with a missing-key diagnostic naming the reference', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const resolveApiKey = vi.fn(async () => undefined)
    await expect(provider({ apiKey: undefined, resolveApiKey, apiKeyEnv: credentialRef('TAVILY_API_KEY') }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('TAVILY_API_KEY') }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tv-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('threads searchDepth, maxResults and includeAnswer config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tv-key', searchDepth: 'advanced', maxResults: 9, includeAnswer: false })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ search_depth: 'advanced', max_results: 9, include_answer: false })
    await fiber.dispose()
  })

  it('falls back to $TAVILY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.tavily.com/search')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('fails loud at search time when no layer supplies a key', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('TAVILY_API_KEY') }))
    } finally {
      if (prev !== undefined) process.env.TAVILY_API_KEY = prev
    }
  })
})
