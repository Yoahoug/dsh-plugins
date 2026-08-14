# @dsh-plugins/web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Tavily's `POST /search` endpoint, requests a synthesized answer, and maps the generated `answer` and the flat `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key; prefer `apiKeyEnv` so no secret enters configuration files. |
| `apiKeyEnv` | `$TAVILY_API_KEY` | Credential reference resolved for each search through the credentials service, with the launch environment as fallback. |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily's `search_depth`: `basic` (fast) or `advanced` (deeper analysis). |
| `maxResults` | `5` | Default result count when a request carries no `maxResults`. Must be a positive integer. |
| `includeAnswer` | `true` | Whether Tavily generates a synthesized answer, mapped to the result's `content`. |

```yaml
- id: web-search-tavily
  name: '@dsh-plugins/web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## Settings namespace (UI card reuse)

This provider registers its settings section under the **`web-search-deepseek`**
namespace, not a tavily-owned one. The Web settings card and the apiproxy
settings allow-list hardcode that namespace, so an out-of-tree provider must
reuse it to render its card without editing the harness (Option A in
`docs/tavily-search-development.md` §4.3). Consequences:

- The profile **must keep the official `web-search-deepseek` row disabled**
  (`disabled: true`), otherwise both plugins register the same namespace and
  settings startup fails.
- The card's `maxUses` field maps to the official provider's config key and is
  **ignored** by this plugin (Tavily honors `maxResults`); the card's key
  control addresses the section's `apiKeyEnv` (default `TAVILY_API_KEY`) and
  stores through the credentials service, which this plugin resolves.
- If the harness ever generalizes the card to provider-declared namespaces
  (upstream Option B), migrate this section back to `web-search-tavily`.

## Mapping

Tavily's generated `answer` (when `includeAnswer` is on) becomes `content`. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the trimmed `content` excerpt (a result with a blank excerpt has no portable snippet and is dropped), `publishedAt` ← `published_date`. A request's `maxResults` wins over the configured `maxResults` default and is sent as Tavily's `max_results` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, content excerpts, publication dates, and the synthesized answer, or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper while provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with a blank content excerpt is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `searchDepth`/`maxResults`/`includeAnswer` are exposed** — Tavily's other controls (topic, time range, domain filters, news `days`) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
