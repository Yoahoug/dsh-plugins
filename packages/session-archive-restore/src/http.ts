import type { IncomingMessage, ServerResponse } from 'node:http'

/** The DSH webserver may bind all interfaces; this endpoint must remain local. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === '127.0.0.1' || address === '::1') return true
  return address?.startsWith('::ffff:127.') === true
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function sendMethodNotAllowed(res: ServerResponse, allowed: string): void {
  res.writeHead(405, { allow: allowed })
  res.end()
}

/** Read a small JSON request body without allowing an unbounded socket read. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('request body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

