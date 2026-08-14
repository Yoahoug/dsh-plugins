/**
 * Real HTTP coverage proves whether native `fetch` contacts a cross-origin
 * `Location` when the vision endpoint redirects; mocked request-init
 * assertions alone cannot observe that boundary. The credential rides the
 * `Authorization` header, so a followed redirect would forward it — the
 * bridge must reject before contact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describeImageViaEndpoint } from '@dsh-plugins/vision-bridge'
import type { VisionBridgeOptions } from '@dsh-plugins/vision-bridge'
import { PNG_1X1 } from './helpers.ts'

const TEST_API_KEY = 'redirect-test-key'

/** A stored-image fixture the endpoint client only reads bytes from. */
const stored: StoredImageAttachment = {
  ref: {
    attachmentId: AttachmentId('sha256:redirect-fixture'),
    mediaType: 'image/png',
    bytes: PNG_1X1.length,
    width: 1,
    height: 1,
  },
  data: PNG_1X1,
}

const options = (baseURL: string): VisionBridgeOptions => ({
  enabled: true,
  baseURL,
  model: 'gemini-3.6-flash',
  apiKeyEnv: credentialRef('Z_AI_API_KEY'),
  describePrompt: 'describe',
  apiKey: TEST_API_KEY,
})

const targetRequests: ReceivedRequest[] = []

interface ReceivedRequest {
  readonly headers: IncomingMessage['headers']
  readonly method?: string
}

let redirectOrigin: string
let targetOrigin: string

const targetServer = createServer((request, response) => {
  request.resume()
  targetRequests.push({
    ...request.method !== undefined ? { method: request.method } : {},
    headers: request.headers,
  })
  response.writeHead(204).end()
})

const redirectServer = createServer((request, response) => {
  request.resume()
  const status = Number(new URL(request.url ?? '/', 'http://fixture.test').pathname.split('/')[1])
  response.writeHead(status, { location: `${targetOrigin}/collect` }).end()
})

beforeAll(async () => {
  targetOrigin = await listen(targetServer)
  redirectOrigin = await listen(redirectServer)
})

afterAll(async () => {
  await Promise.all([close(redirectServer), close(targetServer)])
})

describe('describeImageViaEndpoint redirect policy', () => {
  it.each([301, 302, 303, 307, 308])('rejects HTTP %i before contacting Location', async (status) => {
    targetRequests.length = 0
    await expect(describeImageViaEndpoint(options(`${redirectOrigin}/${status}`), TEST_API_KEY, stored))
      .rejects.toThrow('describe_image request failed')
    expect(targetRequests).toHaveLength(0)
  })

  it('shows default 307 following forwards the POST body and custom headers', async () => {
    targetRequests.length = 0
    const body = JSON.stringify({ model: 'gemini-3.6-flash' })
    await fetch(`${redirectOrigin}/307`, {
      method: 'POST',
      headers: {
        'x-api-key': TEST_API_KEY,
        'content-type': 'application/json',
      },
      body,
    })

    expect(targetRequests).toHaveLength(1)
    expect(targetRequests[0]).toMatchObject({ method: 'POST' })
    expect(targetRequests[0]?.headers['x-api-key']).toBe(TEST_API_KEY)
  })
})

/** Listen on an ephemeral loopback port and return the server origin. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

/** Close a listening fixture server after every request has settled. */
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
}
