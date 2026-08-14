/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily Search API
 * (`POST /search` with a generated answer when requested). It maps Tavily's
 * synthesized `answer` to `content`, maps each result's `content` excerpt to
 * `snippet` and `published_date` to `publishedAt`, and drops entries without a
 * usable snippet.
 * @module @dsh-plugins/web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth: fast basic search. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic' as const

/** Default result count requested when a request carries no `maxResults`. */
export const TAVILY_DEFAULT_MAX_RESULTS = 5

/** Whether Tavily is asked to synthesize an answer into `content` by default. */
export const TAVILY_DEFAULT_INCLUDE_ANSWER = true

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth: 'basic' | 'advanced'
  /** Default result count when a request carries no `maxResults`. */
  maxResults: number
  /** Whether Tavily generates a synthesized answer mapped to `content`. */
  includeAnswer: boolean
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no portable snippet (an entry with a blank `content` is dropped — the seam
 * has no other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank content excerpt.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  const snippet = result.content?.trim()
  if (snippet === undefined || snippet.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.published_date != null && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. The generated
 * `answer` becomes `content` when present and non-blank; snippet-less entries
 * are dropped ({@link mapTavilyResult}).
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  const answer = response.answer?.trim()
  // The web service owns the final `maxResults` truncation, so this provider
  // reports `truncated: false`.
  return {
    ...answer !== undefined && answer.length > 0 ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   *   once at each operation's entry so one search never mixes two sections. A
   *   thunk rather than a value because the plugin's settings section can
   *   change between searches, and re-registering the provider to carry a new
   *   endpoint would make the seam's selection observable to the user as a
   *   flicker.
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = options.apiKey ?? await this.resolveCredential(options)
    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? options.maxResults
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: options.searchDepth,
          include_answer: options.includeAnswer,
          ...numResults !== undefined ? { max_results: numResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve the API key through the provider's credential resolver, or fail
   * with the named reference so the operator knows which credential to store.
   *
   * @param options - the operation's option snapshot.
   * @returns the resolved key.
   * @throws {@link WebError} `WEB_PROVIDER_ERROR` when no layer supplies a key.
   */
  private async resolveCredential(options: TavilySearchProviderOptions): Promise<string> {
    if (options.resolveApiKey === undefined) {
      throw missingKeyError(options.apiKeyEnv)
    }
    try {
      const key = await options.resolveApiKey()
      if (key !== undefined && key.length > 0) return key
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throw missingKeyError(options.apiKeyEnv)
  }
}

/** A missing-key diagnostic naming the reference the operator must fill. */
function missingKeyError(ref: CredentialRef | undefined): WebError {
  return new WebError(
    ref === undefined
      ? 'Tavily search has no API key; provide one through the credentials service or "apiKey" in the web-search-tavily config'
      : `Tavily search has no API key for "${ref}"; store it through the credentials service`
      + ' or set "apiKey" in the web-search-tavily config',
    'WEB_PROVIDER_ERROR',
  )
}

/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
