/**
 * Wire types for `@dsh-plugins/skill-external-roots`. Types only — no runtime
 * code. The provider discovers skill candidates from external agent tool roots
 * (codex / claude / cursor / opencode), so the wire surface is the opaque
 * per-candidate locator it hands the `ctx.skills` registry and the probe shape
 * it records into the package health state (consumed by `./invariant`).
 *
 * @module @dsh-plugins/skill-external-roots/types
 */

/** One external tool family the plugin knows a default root for. */
export type ExternalRootKind = 'codex' | 'claude' | 'cursor' | 'opencode' | 'agents'

/**
 * Opaque provider-owned handle passed back to `provider.get()` through the
 * registry. Carries the absolute skill file path and the directory used as
 * the `resourceBase` (the skill directory for `<name>/SKILL.md` bundles, the
 * root itself for flat `<name>.md` files).
 */
export interface ExternalSkillLocator {
  /** Absolute path to the skill file (`SKILL.md` or a flat `.md` file). */
  readonly path: string
  /** Absolute directory against which relative skill resources resolve. */
  readonly directory: string
}

/**
 * One recorded scan of an external root, written by the provider after every
 * `list()` and read by the invariant companion. Carries the relation the
 * package checks: root existence and the candidate paths that scan produced.
 */
export interface ExternalRootProbe {
  /** Absolute root path that was scanned. */
  readonly root: string
  /** Whether the root existed (a readable directory) at scan time. */
  readonly exists: boolean
  /** Absolute candidate skill-file paths the scan produced. */
  readonly candidates: readonly string[]
  /** Epoch millis of the scan. */
  readonly scannedAt: number
}
