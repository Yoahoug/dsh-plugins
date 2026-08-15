/**
 * Package-owned invariant companion for `@dsh-plugins/skill-external-roots`.
 *
 * The package's data relation lives between the provider's scans and the
 * candidates it publishes: every recorded root must keep its candidate paths
 * inside itself (a locator escaping its root would hand `get()` a file the
 * catalog never saw), and a root recorded as missing must never produce
 * candidates (a vanished root publishing stale entries would make `get()`
 * lie). This companion re-checks that relation on every `skills/change`
 * (the registry invalidates and re-collects the provider after any
 * filesystem event or provider change).
 *
 * @module @dsh-plugins/skill-external-roots/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { externalRootsHealth, pathInsideRoot } from './provider.ts'
import type { ExternalRootsHealth } from './provider.ts'

const PACKAGE_NAME = '@dsh-plugins/skill-external-roots'

/** Cordis companion plugin name. */
export const name = 'skill-external-roots-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one health snapshot against the package's data relation.
 * Exported separately so the checks are testable without mounting the
 * companion.
 * @param health - the health snapshot to check; `undefined` skips (no plugin instance yet).
 * @param fail - reporter bound to the registering package name.
 */
export function checkExternalRootsHealth(
  health: ExternalRootsHealth | undefined,
  fail: InvariantFailure,
): void {
  if (health === undefined) return
  for (const probe of health.snapshot()) {
    for (const candidate of probe.candidates) {
      if (!pathInsideRoot(probe.root, candidate)) {
        fail(`candidate "${candidate}" lies outside its recorded root "${probe.root}"`)
      }
    }
    if (!probe.exists && probe.candidates.length > 0) {
      fail(`root "${probe.root}" was recorded as missing but produced ${probe.candidates.length} candidates`)
    }
  }
}

/**
 * Install the package's invariant checks: one synchronous pass over the
 * current health at install time, then a re-check on every `skills/change`.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const check = (): void => {
    checkExternalRootsHealth(externalRootsHealth(), fail)
  }
  check()
  ctx.on('skills/change', check, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
