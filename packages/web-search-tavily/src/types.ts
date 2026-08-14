/**
 * Wire types for the Tavily Search API (`POST https://api.tavily.com/search`).
 * Types only — no runtime code. Tavily returns an optional generated `answer`
 * (when `include_answer` is set) and a flat `results[]`; each entry carries a
 * title, URL, content excerpt, relevance score, and (for news topics) a
 * `published_date`.
 *
 * @module @dsh-plugins/web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  /** Retrieval depth: `basic` (fast) or `advanced` (deeper analysis). */
  search_depth: 'basic' | 'advanced'
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
  /** Whether Tavily synthesizes an answer into the response's `answer`. */
  include_answer: boolean
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  url: string
  title?: string | null
  content?: string | null
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  /** Generated answer synthesizing the results, when `include_answer` was set. */
  answer?: string
  results?: TavilyResult[]
}

/** Tavily's error response envelope (best-effort; fields vary by failure). */
export interface TavilyError {
  error?: string
  message?: string
}
