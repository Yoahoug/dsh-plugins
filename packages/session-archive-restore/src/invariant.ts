import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'

const PACKAGE_NAME = '@dsh-plugins/session-archive-restore'

export const name = 'session-archive-restore-invariant'
export const inject = ['invariants']

/** Verify that the workspace global consumed by the endpoint remains valid. */
export const apply = (ctx: Context): Promise<() => void> => {
  const install: InvariantInstaller = (runtime: Context, fail: InvariantFailure) => {
    runtime.on('domain/changed', (change) => {
      if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
      const result = workspaceDomainState.safeParse(change.value)
      if (!result.success) fail(`workspace global emitted by DSH is not schema-valid: ${result.error.message}`)
    }, { global: true })
  }
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}
