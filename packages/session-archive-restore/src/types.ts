/** Wire types shared by the local launcher ↔ DSH plugin HTTP contract. */

export interface ArchiveSessionsResponse {
  version: number
  archivedSessionIds: string[]
}

export interface RestoreSessionRequest {
  sessionId: string
}

export interface RestoreSessionResponse extends ArchiveSessionsResponse {
  restoredSessionId: string
}

export interface DeleteSessionRequest {
  sessionId: string
}

export interface DeleteSessionResponse extends ArchiveSessionsResponse {
  deletedSessionId: string
}

export interface DeleteAllSessionsResponse extends ArchiveSessionsResponse {
  deletedCount: number
}
