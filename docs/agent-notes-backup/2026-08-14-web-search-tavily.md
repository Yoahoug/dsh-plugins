# Agent Note: Tavily as the shipped web search backend

Status: implemented

English | [中文](2026-08-14-web-search-tavily.zh.md)

## Problem

The shipped `web_search` ran on `@deepseek-ai/dsh-web-search-deepseek`'s Anthropic-compatible Messages call with the native `web_search_20250305` server tool. Every search cost a full auxiliary model turn, the endpoint diverged from the chat-completions base, and the provider carried DeepSeek-specific session events and settings. The product wanted one dedicated search API: Tavily's `POST /search` returns an optional generated answer plus a flat `results[]` in a single plain HTTP round trip, with no model turn.

## Decision

`@deepseek-ai/dsh-web-search-tavily` becomes the only shipped search provider. The base composition mounts `dsh-web` with `searchProvider: tavily` and the `web-search-tavily` row with `apiKeyEnv: TAVILY_API_KEY`; the Exa, Perplexity, and DeepSeek search provider packages are deleted, and `dsh-tool-web`'s `searchTimeoutMs: 60000` override is removed because a plain HTTP search no longer needs the auxiliary-model-turn budget.

**Provider shape.** The plugin is a function/namespace plugin (`inject: ['web']`) registering a `TavilySearchProvider` into `ctx.web`, following the Exa package structure and the DeepSeek credential/settings pattern. Config carries `apiKey`, `apiKeyEnv` (default `TAVILY_API_KEY`), `baseURL` (default `https://api.tavily.com`, operation `/search`), `searchDepth` (`basic`/`advanced`, default `basic`), `maxResults` (default `5`), and `includeAnswer` (default `true`). The key resolves per search through the optional `ctx.credentials` service with the launch environment as fallback, exactly like the DeepSeek provider, so a key entered or rotated on the web Models/Settings page reaches the next search without a restart; missing keys fail the operation with a `WEB_PROVIDER_ERROR` naming the reference, while `available()` treats the installed resolver as locally usable.

**Mapping.** Tavily's generated `answer` becomes `WebSearchResult.content`; each `results[]` entry maps `url`, `title`, the trimmed `content` excerpt to `snippet` (blank-excerpt entries are dropped), and `published_date` to `publishedAt`. The request sends the request-level `maxResults` as Tavily's `max_results` when present, else the configured default, for a cost/latency optimization; the seam still enforces the final bound. HTTP redirects are rejected before the `Location` target is contacted (`redirect: 'error'`), per the web-packages redirect rule; abort classification and error vocabulary follow the Exa provider exactly (`WEB_ABORTED` / `WEB_PROVIDER_ERROR`).

**Settings and UI.** The plugin registers the `web-search-tavily` settings namespace (endpoint, depth, result count, key reference) and projects options per search through a source thunk, so a stored change reaches the next search without re-registering the provider. The web settings card (`dsh-client-ui-settings-plugins`) edits `apiKeyEnv`/`baseURL`/`maxResults` and writes the key through the credentials domain; the apiproxy `WEB_SETTINGS_NAMESPACES` allowlist entry and the card namespace rename from `web-search-deepseek` to `web-search-tavily`. The DeepSeek-only `web/deepseek-search-llm-request` session event is gone: a Tavily search is a plain tool result, durably logged as `tool/call`/`tool/result` with no auxiliary model request.

**Security boundary, unchanged.** `web_fetch` stays disabled and no fetch provider is mounted, preserving the shipped stance that the model may not select arbitrary URL retrieval.

## Alternatives considered

**Keep DeepSeek search and add Tavily alongside it.** Rejected: the product wants one shipped search backend, and the base composition pins `searchProvider` explicitly, so extra providers would only be selectable through overlays; the deleted packages have no external consumers in this repo (pre-release stance).

**Reuse `api_key` in the request body.** Rejected: Tavily accepts both forms, but the `Authorization: Bearer` header keeps the secret out of the JSON body, matching the Exa provider's credential handling and the redirect-rejection rationale.

**Send no default `max_results`.** Rejected: Tavily's own default is 5, but the plugin's `maxResults` default keeps the shipped behavior explicit and configurable, and the web settings card edits it.

## Consequences

Every shipped surface's `web_search` now costs one plain HTTP round trip against Tavily instead of an auxiliary model turn; the model-visible tool schema, prompt guidance, and source-card presentation are unchanged, because `dsh-tool-web` owns them. The Web snapshot lane (`apps/web/tests/web-search-round.e2e.ts`) replays the model stream while the real Tavily provider calls a deterministic local JSON double, asserting the `/search` request (bearer key, `query`, `search_depth`, `include_answer`, `max_results`), the generated answer mapped to content, the capped structured result, and the settled card golden. Unit coverage pins mapping, availability, request shaping, redirect rejection (real HTTP), credential resolution, the settings section, and HMR-safe registration; the real-API smoke self-skips without `$TAVILY_API_KEY`.
