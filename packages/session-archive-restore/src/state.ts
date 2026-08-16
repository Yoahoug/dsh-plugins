import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceDomainState } from '@deepseek-ai/dsh-workspace'

/** Public API version for the launcher ↔ plugin archive endpoint. */
export const ARCHIVE_API_VERSION = 1

/** The DSH workspace domain opened by WorkspaceRegistry. */
export const WORKSPACE_DOMAIN_NAME = 'workspace'

/** Session ids are opaque, but must stay a bounded JSON string without controls. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Remove one id from the archive set while preserving every other workspace
 * domain field. WorkspaceRegistry deliberately keeps the session's original
 * sessionIds slot, so this is enough for the native UI to show it again.
 */
export function restoreArchivedSession(
  state: WorkspaceDomainState,
  sessionId: string,
): { state: WorkspaceDomainState; changed: boolean } {
  if (!isValidSessionId(sessionId)) throw new Error('invalid session id')
  if (!state.archivedSessionIds.includes(sessionId as WorkspaceDomainState['archivedSessionIds'][number])) {
    return { state, changed: false }
  }
  return {
    state: {
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    },
    changed: true,
  }
}

/** Remove one archived id while preserving the caller's immutable input. */
export function deleteArchivedSession(
  state: WorkspaceDomainState,
  sessionId: string,
): { state: WorkspaceDomainState; changed: boolean } {
  if (!isValidSessionId(sessionId)) throw new Error('invalid session id')
  if (!state.archivedSessionIds.includes(sessionId as WorkspaceDomainState['archivedSessionIds'][number])) {
    return { state, changed: false }
  }
  return {
    state: {
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    },
    changed: true,
  }
}

/** Validate a value read from the live domain before returning it on the wire. */
export function parseWorkspaceState(value: unknown): WorkspaceDomainState {
  return workspaceDomainState.parse(value)
}
