/**
 * Local hot restore endpoint for DSH archived sessions.
 *
 * This plugin intentionally consumes the already-open workspace domain. It
 * does not open a second domain, edit storage files, or touch session logs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { dirname } from 'node:path'
import { rm, rmdir } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { ARCHIVE_API_VERSION, deleteArchivedSession, isValidSessionId, parseWorkspaceState, restoreArchivedSession, WORKSPACE_DOMAIN_NAME } from './state.ts'
import { isLoopbackRequest, readJsonBody, sendJson, sendMethodNotAllowed } from './http.ts'
import type { DeleteAllSessionsResponse, DeleteSessionRequest, DeleteSessionResponse } from './types.ts'
export type { ArchiveSessionsResponse, DeleteAllSessionsResponse, DeleteSessionRequest, DeleteSessionResponse, RestoreSessionRequest, RestoreSessionResponse } from './types.ts'

export { ARCHIVE_API_VERSION, deleteArchivedSession, isValidSessionId, parseWorkspaceState, restoreArchivedSession, SESSION_ID_PATTERN, WORKSPACE_DOMAIN_NAME } from './state.ts'
export { isLoopbackRequest, readJsonBody, sendJson } from './http.ts'

export const name = 'session-archive-restore'
export const inject = ['webServer', 'storageDomain', 'workspaceRegistry', 'sessions', 'sessionPersistence']

export interface Config {}
export const Config: z<Config> = z.object({})

const ARCHIVE_ROUTE = '/api/dsh-launcher/archive-sessions'
const RESTORE_ROUTE = `${ARCHIVE_ROUTE}/restore`
const DELETE_ROUTE = `${ARCHIVE_ROUTE}/delete`
const DELETE_ALL_ROUTE = `${ARCHIVE_ROUTE}/delete-all`

interface RestoreRequest {
  sessionId?: unknown
}

interface SessionHeaderLike {
  id: string
  cwd?: string
}

interface SessionPersistenceLike {
  supportsRawArtifacts: boolean
  list(): Promise<SessionHeaderLike[]>
  locate(meta: SessionHeaderLike): { kind: string; path: string } | undefined
}

interface RuntimeServices {
  sessions: { get(sessionId: string): unknown }
  sessionPersistence: SessionPersistenceLike
}

interface WorkspaceRecordLike {
  sessionIds: string[]
  [key: string]: unknown
}

interface WorkspaceTableLike {
  entries(): IterableIterator<[string, WorkspaceRecordLike]>
  update(id: string, fn: (value: WorkspaceRecordLike) => WorkspaceRecordLike): Promise<WorkspaceRecordLike>
}

function runtimeServices(ctx: Context): RuntimeServices {
  return ctx as unknown as RuntimeServices
}

function domainFor(ctx: Context) {
  const domain = ctx.storageDomain.get(WORKSPACE_DOMAIN_NAME)
  if (domain === undefined) throw new Error('workspace domain is not open')
  return domain
}

/**
 * WorkspaceRegistry currently snapshots the workspace global during init and
 * does not expose an unarchive method. Keep that in-memory snapshot aligned
 * after the domain write so native workspace.list calls see the same state as
 * this plugin and the domain change event.
 */
function syncWorkspaceRegistryCache(ctx: Context, state: ReturnType<typeof parseWorkspaceState>): void {
  const registry = ctx.workspaceRegistry as unknown as { state?: ReturnType<typeof parseWorkspaceState> }
  registry.state = state
}

async function sessionHeaderFor(ctx: Context, sessionId: string): Promise<SessionHeaderLike> {
  const runtime = runtimeServices(ctx)
  if (runtime.sessions.get(sessionId) !== undefined) {
    throw new Error('不能删除正在运行中的会话，请先停止该会话')
  }
  const header = (await runtime.sessionPersistence.list()).find((item) => item.id === sessionId)
  if (header === undefined) throw new Error('会话日志不存在或存储后端不可读')
  return header
}

async function deleteSessionArtifact(ctx: Context, header: SessionHeaderLike): Promise<void> {
  const persistence = runtimeServices(ctx).sessionPersistence
  if (!persistence.supportsRawArtifacts) {
    throw new Error('当前会话存储后端不支持永久删除')
  }
  const location = persistence.locate(header)
  if (location === undefined || location.kind !== 'jsonl') {
    throw new Error('当前仅支持删除 JSONL 会话存储')
  }
  await rm(location.path, { force: true })
  try {
    await rmdir(dirname(location.path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error
  }
}

async function deleteProjectionCache(ctx: Context, sessionId: string): Promise<void> {
  const domain = ctx.storageDomain.get('session_projcache')
  if (domain !== undefined) await domain.table('sessions').delete(sessionId as never)
}

async function deleteOne(ctx: Context, sessionId: string): Promise<{ state: ReturnType<typeof parseWorkspaceState>; changed: boolean }> {
  const domain = domainFor(ctx)
  const current = parseWorkspaceState(domain.global.get())
  const result = deleteArchivedSession(current, sessionId)
  if (!result.changed) return result
  const header = await sessionHeaderFor(ctx, sessionId)
  const workspaces = domain.table('workspaces') as unknown as WorkspaceTableLike
  for (const [workspaceId, record] of workspaces.entries()) {
    if (!record.sessionIds.includes(sessionId)) continue
    await workspaces.update(workspaceId, (value) => ({
      ...value,
      sessionIds: value.sessionIds.filter((id) => id !== sessionId),
    }))
  }
  await domain.global.set(result.state)
  syncWorkspaceRegistryCache(ctx, result.state)
  await deleteProjectionCache(ctx, sessionId)
  await deleteSessionArtifact(ctx, header)
  return result
}

function archiveResponse(state: ReturnType<typeof parseWorkspaceState>) {
  return {
    version: ARCHIVE_API_VERSION,
    archivedSessionIds: [...state.archivedSessionIds],
  }
}

/** Register the launcher-facing local API. */
export function apply(ctx: Context, _config: Config = {}): void {
  const restoreTail: { current: Promise<void> } = { current: Promise.resolve() }

  const getRoute = ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_ROUTE,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'loopback requests only' })
        return
      }
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        const state = parseWorkspaceState(domainFor(ctx).global.get())
        sendJson(res, 200, archiveResponse(state))
      } catch (error) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const restoreRoute = ctx.webServer.register({
    kind: 'exact',
    path: RESTORE_ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'loopback requests only' })
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      try {
        const payload = await readJsonBody(req)
        const sessionId = (payload as RestoreRequest | null)?.sessionId
        if (!isValidSessionId(sessionId)) {
          sendJson(res, 400, { error: 'invalid session id' })
          return
        }

        let result: { state: ReturnType<typeof parseWorkspaceState>; changed: boolean } | undefined
        const operation = restoreTail.current.then(async () => {
          const domain = domainFor(ctx)
          const current = parseWorkspaceState(domain.global.get())
          result = restoreArchivedSession(current, sessionId)
          if (result.changed) {
            await domain.global.set(result.state)
            syncWorkspaceRegistryCache(ctx, result.state)
          }
        })
        restoreTail.current = operation.then(() => undefined, () => undefined)
        await operation

        if (result === undefined) throw new Error('restore operation did not produce a result')
        if (!result.changed) {
          sendJson(res, 409, { error: 'session is not archived', ...archiveResponse(result.state) })
          return
        }
        sendJson(res, 200, {
          restoredSessionId: sessionId,
          ...archiveResponse(result.state),
        })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const deleteRoute = ctx.webServer.register({
    kind: 'exact',
    path: DELETE_ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'loopback requests only' })
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      try {
        const payload = await readJsonBody(req) as DeleteSessionRequest
        if (!isValidSessionId(payload?.sessionId)) {
          sendJson(res, 400, { error: 'invalid session id' })
          return
        }
        let result: { state: ReturnType<typeof parseWorkspaceState>; changed: boolean } | undefined
        const operation = restoreTail.current.then(async () => {
          result = await deleteOne(ctx, payload.sessionId)
        })
        restoreTail.current = operation.then(() => undefined, () => undefined)
        await operation
        if (result === undefined) throw new Error('delete operation did not produce a result')
        if (!result.changed) {
          sendJson(res, 409, { error: 'session is not archived', ...archiveResponse(result.state) })
          return
        }
        const response: DeleteSessionResponse = {
          deletedSessionId: payload.sessionId,
          ...archiveResponse(result.state),
        }
        sendJson(res, 200, response)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const deleteAllRoute = ctx.webServer.register({
    kind: 'exact',
    path: DELETE_ALL_ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'loopback requests only' })
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      try {
        let result: { state: ReturnType<typeof parseWorkspaceState>; deletedCount: number } | undefined
        const operation = restoreTail.current.then(async () => {
          const current = parseWorkspaceState(domainFor(ctx).global.get())
          let deletedCount = 0
          for (const sessionId of [...current.archivedSessionIds]) {
            const deleted = await deleteOne(ctx, sessionId)
            if (deleted.changed) deletedCount += 1
          }
          result = { state: parseWorkspaceState(domainFor(ctx).global.get()), deletedCount }
        })
        restoreTail.current = operation.then(() => undefined, () => undefined)
        await operation
        if (result === undefined) throw new Error('delete-all operation did not produce a result')
        const response: DeleteAllSessionsResponse = {
          deletedCount: result.deletedCount,
          ...archiveResponse(result.state),
        }
        sendJson(res, 200, response)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.effect(function* () {
    yield () => {
      getRoute()
      restoreRoute()
      deleteRoute()
      deleteAllRoute()
    }
  }, 'session-archive-restore routes')
}
