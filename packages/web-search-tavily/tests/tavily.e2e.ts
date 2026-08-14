import { describe, expect, it } from 'vitest'
import {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_INCLUDE_ANSWER,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TavilySearchProvider,
} from '@dsh-plugins/web-search-tavily'

/**
 * Real-API smoke for the Tavily search provider. Self-skips without `$TAVILY_API_KEY`
 * (CI has no secrets), per the with-key e2e policy in docs/testing.md.
 */
const apiKey = process.env.TAVILY_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('TavilySearchProvider real API', () => {
  it('returns sources and a synthesized answer for a live query', async () => {
    const provider = new TavilySearchProvider(() => ({
      apiKey: apiKey!,
      baseURL: process.env.TAVILY_BASE_URL ?? TAVILY_DEFAULT_BASE_URL,
      searchDepth: TAVILY_DEFAULT_SEARCH_DEPTH,
      maxResults: TAVILY_DEFAULT_MAX_RESULTS,
      includeAnswer: TAVILY_DEFAULT_INCLUDE_ANSWER,
    }))
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    expect(result.content).toBeDefined()
  }, 30_000)
})
