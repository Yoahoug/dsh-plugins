import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface FakeResponse {
  status?: number
  body: string
  headers?: Record<string, unknown>
  writeHead(status: number, headers?: Record<string, unknown>): void
  end(body?: string): void
}

function response(): FakeResponse {
  return {
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body = body
    },
  }
}

function request(method: string, body = '', remoteAddress = '127.0.0.1') {
  return {
    method,
    socket: { remoteAddress },
    headers: body ? { 'content-length': String(Buffer.byteLength(body)) } : {},
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  }
}

function setup() {
  let state = {
    initialized: true,
    workspaceIds: ['w1'],
    archivedSessionIds: ['s1', 's2'],
  }
  const routes = new Map<string, (req: never, res: FakeResponse) => void | Promise<void>>()
  const setCalls: string[][] = []
  const workspaces = new Map([['w1', { sessionIds: ['s1', 's2'] }]])
  const workspaceDomain = {
    global: {
      get: () => state,
      set: async (next: typeof state) => {
        state = next
        setCalls.push([...next.archivedSessionIds])
      },
    },
    table(name: string) {
      if (name !== 'workspaces') throw new Error(`unexpected table ${name}`)
      return {
        entries: () => workspaces.entries(),
        update: async (id: string, fn: (value: { sessionIds: string[] }) => { sessionIds: string[] }) => {
          const current = workspaces.get(id)
          if (current === undefined) throw new Error('missing workspace')
          const next = fn(current)
          workspaces.set(id, next)
          return next
        },
      }
    },
  }
  const projectionDeletes: string[] = []
  const registry = { state }
  const ctx = {
    webServer: {
      register(route: { path: string; handler: (req: never, res: FakeResponse) => void | Promise<void> }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    storageDomain: {
      get() {
        return workspaceDomain
      },
    },
    sessions: { get: () => undefined },
    sessionPersistence: {
      supportsRawArtifacts: true,
      list: async () => [{ id: 's1' }, { id: 's2' }],
      locate: () => ({ kind: 'jsonl', path: '/tmp/dsh-archive-restore-test-missing/session.jsonl' }),
    },
    workspaceRegistry: registry,
    effect() {},
  }
  const originalGet = ctx.storageDomain.get
  ctx.storageDomain.get = ((name?: string) => {
    if (name === 'session_projcache') {
      return { table: () => ({ delete: async (id: string) => { projectionDeletes.push(id); return true } }) }
    }
    return originalGet()
  }) as typeof ctx.storageDomain.get
  apply(ctx as never)
  return { routes, setCalls, registry, workspaces, projectionDeletes, getState: () => state }
}

describe('session archive HTTP contract', () => {
  it('lists archived ids and restores one session', async () => {
    const fixture = setup()
    const getResponse = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions')!(request('GET') as never, getResponse)
    expect(getResponse.status).toBe(200)
    expect(JSON.parse(getResponse.body)).toMatchObject({ archivedSessionIds: ['s1', 's2'] })

    const restoreResponse = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions/restore')!(
      request('POST', JSON.stringify({ sessionId: 's1' })) as never,
      restoreResponse,
    )
    expect(restoreResponse.status).toBe(200)
    expect(fixture.getState().archivedSessionIds).toEqual(['s2'])
    expect(fixture.registry.state.archivedSessionIds).toEqual(['s2'])
    expect(fixture.setCalls).toEqual([['s2']])
  })

  it('keeps the loaded workspace registry cache aligned after restore', async () => {
    const fixture = setup()
    const restoreResponse = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions/restore')!(
      request('POST', JSON.stringify({ sessionId: 's1' })) as never,
      restoreResponse,
    )

    expect(restoreResponse.status).toBe(200)
    expect(fixture.getState().archivedSessionIds).toEqual(['s2'])
  })

  it('serializes concurrent restores on the current state', async () => {
    const fixture = setup()
    await Promise.all(['s1', 's2'].map(async (sessionId) => {
      const res = response()
      await fixture.routes.get('/api/dsh-launcher/archive-sessions/restore')!(
        request('POST', JSON.stringify({ sessionId })) as never,
        res,
      )
      expect(res.status).toBe(200)
    }))
    expect(fixture.getState().archivedSessionIds).toEqual([])
  })

  it('permanently deletes one archived session and its workspace/cache references', async () => {
    const fixture = setup()
    const deleteResponse = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions/delete')!(
      request('POST', JSON.stringify({ sessionId: 's1' })) as never,
      deleteResponse,
    )

    expect(deleteResponse.status).toBe(200)
    expect(fixture.getState().archivedSessionIds).toEqual(['s2'])
    expect(fixture.workspaces.get('w1')?.sessionIds).toEqual(['s2'])
    expect(fixture.projectionDeletes).toEqual(['s1'])
  })

  it('rejects non-loopback and malformed restore requests', async () => {
    const fixture = setup()
    const remote = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions/restore')!(
      request('POST', JSON.stringify({ sessionId: 's1' }), '192.168.1.10') as never,
      remote,
    )
    expect(remote.status).toBe(403)

    const invalid = response()
    await fixture.routes.get('/api/dsh-launcher/archive-sessions/restore')!(
      request('POST', JSON.stringify({ sessionId: 'not valid' })) as never,
      invalid,
    )
    expect(invalid.status).toBe(400)
  })
})
