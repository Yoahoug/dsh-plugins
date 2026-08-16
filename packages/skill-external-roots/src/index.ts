/**
 * `@dsh-plugins/skill-external-roots`: registers an `ExternalRootsProvider`
 * with `ctx.skills`. A function/namespace plugin (NOT a default-export
 * service): a skill provider does not own the `ctx.skills` key — it registers
 * INTO the registry, exactly as `@deepseek-ai/dsh-skill-filesystem` does. The
 * key is owned by `@deepseek-ai/dsh-skill`.
 *
 * The provider mounts skills already present in external agent tool roots
 * (codex / claude / cursor / opencode) as `source: 'external'` candidates at
 * rank 350 — after project skills (100/200), before user skills (400/500) —
 * so skills written for those tools become directly callable by the dsh
 * model. `~/.agents/skills` is NOT mounted by default: the built-in
 * `skill-filesystem` provider already scans it (user-agents rank 500), and
 * mounting it here would show every agent skill twice.
 *
 * @module @dsh-plugins/skill-external-roots
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME,
  EXTERNAL_ROOTS_DEFAULT_RANK,
  ExternalRootsHealth,
  ExternalRootsProvider,
  registerExternalRootsHealth,
} from './provider.ts'
import type { ExternalRootsProviderOptions } from './provider.ts'

export {
  EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME,
  EXTERNAL_ROOTS_DEFAULT_RANK,
  EXTERNAL_SOURCE,
  ExternalRootsHealth,
  ExternalRootsProvider,
  defaultRootCandidates,
  parseExternalSkill,
  pathInsideRoot,
  registerExternalRootsHealth,
  externalRootsHealth,
} from './provider.ts'
export type { ExternalRootsProviderOptions, ParsedSkill, SkillParseOutcome } from './provider.ts'
export type { ExternalRootKind, ExternalRootProbe, ExternalSkillLocator } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-external-roots'

/** The skill registry this provider registers into. */
export const inject = ['skills']

/**
 * Plugin config (all optional — defaults are explicit in the schema and in
 * `resolveOptions`). No secrets: this plugin only reads local directories.
 */
export interface Config {
  /** Unique provider name in the `ctx.skills` registry. Defaults to `external-roots`. */
  providerName?: string
  /** Per-tool family switch. Defaults to all `true`; only existing roots mount. */
  enabled?: { codex?: boolean; claude?: boolean; cursor?: boolean; opencode?: boolean }
  /** Extra roots scanned after the defaults, in order, also `source: 'external'`. */
  customDirs?: string[]
  /** Explicitly mount `~/.agents/skills`; defaults to `false` (built-in provider covers it). */
  agentsRoot?: boolean
  /** Candidate rank. Defaults to `350` (project < external < user). */
  rank?: number
  /** Skill names to drop from the catalog. Defaults to none. */
  exclude?: string[]
  /** Whether chokidar invalidates the registry on root-directory changes. Defaults to `true`. */
  watch?: boolean
  /**
   * Launcher-written per-skill injection control file
   * (`$DSH_HOME/skills-control.json`): families/skills with `false` are not
   * mounted; changes invalidate the catalog (HMR, no restart). Unset = v1
   * behavior (everything enabled, no control-file IO/watch).
   */
  skillControlFile?: string
  /**
   * Where the provider writes its actually-registered (post-filter) candidate
   * list after every `list()` (`$DSH_HOME/state/skills-active.json`) — the
   * "已启动" view of the launcher. Unset = no reporting.
   */
  activeFile?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME),
  enabled: z.object({
    codex: z.boolean().default(true),
    claude: z.boolean().default(true),
    cursor: z.boolean().default(true),
    opencode: z.boolean().default(true),
  }).default({ codex: true, claude: true, cursor: true, opencode: true }),
  customDirs: z.array(z.string()).default([]),
  agentsRoot: z.boolean().default(false),
  rank: z.number().step(1).min(0).default(EXTERNAL_ROOTS_DEFAULT_RANK),
  exclude: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  skillControlFile: z.string(),
  activeFile: z.string(),
})

/**
 * Project the plugin config into fully-defaulted provider options. The schema
 * already fills defaults for the configuration surface; the `?? default`
 * fallbacks keep direct construction (unit tests) honest as well.
 * @param config - the authoritative plugin config.
 * @returns options for one provider instance.
 */
function resolveOptions(config: Config): ExternalRootsProviderOptions {
  const enabled = config.enabled ?? {}
  return {
    providerName: config.providerName ?? EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME,
    enabled: {
      codex: enabled.codex ?? true,
      claude: enabled.claude ?? true,
      cursor: enabled.cursor ?? true,
      opencode: enabled.opencode ?? true,
    },
    customDirs: config.customDirs ?? [],
    agentsRoot: config.agentsRoot ?? false,
    rank: config.rank ?? EXTERNAL_ROOTS_DEFAULT_RANK,
    exclude: config.exclude ?? [],
    watch: config.watch ?? true,
    // 空串视为未配置(schemastery 无 optional;显式空串 = 关闭该功能)
    ...(config.skillControlFile ? { skillControlFile: config.skillControlFile } : {}),
    ...(config.activeFile ? { activeFile: config.activeFile } : {}),
  }
}

/**
 * Register the external-roots provider with `ctx.skills`. The provider is
 * created inside the registration factory (the registry borrows the control
 * for its lifecycle); a companion effect disposes the watchers at teardown.
 * @param ctx - plugin context carrying the `skills` service.
 * @param config - plugin config; schema defaults fill every optional field.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const health = new ExternalRootsHealth()
  registerExternalRootsHealth(health)
  let provider!: ExternalRootsProvider
  ctx.skills.registerProvider((control) => {
    provider = new ExternalRootsProvider(ctx, control, resolveOptions(config), health)
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'skill-external-roots watcher')
}
