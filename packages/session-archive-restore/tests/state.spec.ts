import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '../src/http.ts'
import { deleteArchivedSession, isValidSessionId, parseWorkspaceState, restoreArchivedSession } from '../src/state.ts'

const state = parseWorkspaceState({
  initialized: true,
  workspaceIds: ['w1'],
  archivedSessionIds: ['s1', 's2'],
  pendingMutation: undefined,
})

describe('session archive state', () => {
  it('removes only the archived id and preserves workspace state', () => {
    const result = restoreArchivedSession(state, 's1')
    expect(result.changed).toBe(true)
    expect(result.state.archivedSessionIds).toEqual(['s2'])
    expect(result.state.workspaceIds).toEqual(['w1'])
    expect(state.archivedSessionIds).toEqual(['s1', 's2'])
  })

  it('is idempotent and reports a non-archived id as a conflict', () => {
    const result = restoreArchivedSession(state, 'missing')
    expect(result.changed).toBe(false)
    expect(result.state).toBe(state)
  })

  it('deletes only the requested archived id', () => {
    const result = deleteArchivedSession(state, 's1')
    expect(result.changed).toBe(true)
    expect(result.state.archivedSessionIds).toEqual(['s2'])
    expect(result.state.workspaceIds).toEqual(['w1'])
  })

  it('rejects malformed ids', () => {
    expect(isValidSessionId('s-1')).toBe(true)
    expect(isValidSessionId('')).toBe(false)
    expect(isValidSessionId('with space')).toBe(false)
    expect(() => restoreArchivedSession(state, 'with space')).toThrow('invalid session id')
  })
})

describe('loopback policy', () => {
  const request = (remoteAddress: string): Parameters<typeof isLoopbackRequest>[0] => ({
    socket: { remoteAddress } as never,
  })

  it('allows IPv4, IPv6 and mapped loopback addresses only', () => {
    expect(isLoopbackRequest(request('127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(request('::1'))).toBe(true)
    expect(isLoopbackRequest(request('::ffff:127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(request('192.168.1.10'))).toBe(false)
  })
})
