/**
 * `@dsh-plugins/web-search-tavily`: registers a Tavily-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @dsh-plugins/web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_INCLUDE_ANSWER,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TavilySearchProvider,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_INCLUDE_ANSWER,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth?: 'basic' | 'advanced'
  /** Default result count when a request carries no `maxResults`. Defaults to 5. */
  maxResults?: number
  /** Whether Tavily generates a synthesized answer mapped to `content`. Defaults to true. */
  includeAnswer?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  searchDepth: z.union(['basic', 'advanced'] as const).default(TAVILY_DEFAULT_SEARCH_DEPTH),
  maxResults: z.number().step(1).min(1).default(TAVILY_DEFAULT_MAX_RESULTS),
  includeAnswer: z.boolean().default(TAVILY_DEFAULT_INCLUDE_ANSWER),
})

/**
 * Settings namespace carrying this provider's endpoint, depth, and key reference.
 *
 * Deliberately the `web-search-deepseek` namespace (Option A, docs §4.3 of
 * docs/tavily-search-development.md): the Web settings card
 * (`dsh-client-ui-settings-plugins` WebSearchCard) and the apiproxy
 * `WEB_SETTINGS_NAMESPACES` allow-list hardcode that namespace, so an
 * out-of-tree provider must reuse it to render its card without editing the
 * harness. The profile keeps the official `web-search-deepseek` row disabled
 * so this namespace is never registered twice.
 */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
    maxResults: config.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
    includeAnswer: config.includeAnswer ?? TAVILY_DEFAULT_INCLUDE_ANSWER,
  }
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}
