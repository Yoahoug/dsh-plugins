import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  VISION_BRIDGE_DEFAULT_BASE_URL,
  VISION_BRIDGE_DEFAULT_MODEL,
  describeImageViaEndpoint,
} from '@dsh-plugins/vision-bridge'
import type { VisionBridgeOptions } from '@dsh-plugins/vision-bridge'
import { PNG_1X1 } from './helpers.ts'

/**
 * Real-API smoke for the vision endpoint. Self-skips without `$Z_AI_API_KEY`
 * (CI has no secrets), per the with-key e2e policy.
 */
const apiKey = process.env.Z_AI_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('vision bridge real endpoint', () => {
  it('returns a non-empty text description for a real image', async () => {
    const options: VisionBridgeOptions = {
      enabled: true,
      baseURL: process.env.VISION_BRIDGE_BASE_URL ?? VISION_BRIDGE_DEFAULT_BASE_URL,
      model: VISION_BRIDGE_DEFAULT_MODEL,
      apiKeyEnv: credentialRef('Z_AI_API_KEY'),
      describePrompt: 'Describe this image in one short sentence.',
      apiKey: apiKey!,
    }
    const stored: StoredImageAttachment = {
      ref: {
        attachmentId: AttachmentId('sha256:e2e-fixture'),
        mediaType: 'image/png',
        bytes: PNG_1X1.length,
        width: 1,
        height: 1,
      },
      data: PNG_1X1,
    }
    const description = await describeImageViaEndpoint(options, apiKey!, stored)
    expect(description.length).toBeGreaterThan(0)
  }, 30_000)
})
