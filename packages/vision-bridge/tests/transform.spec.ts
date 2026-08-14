/**
 * Pure-function coverage for the request transformer: image-block replacement,
 * already-analyzed placeholders, nested tool-result recursion, system-hint
 * injection idempotency, tool-schema add/strip idempotency, and the
 * "no change" signals that terminate the `llm/stream` re-entry.
 */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  DESCRIBE_IMAGE_TOOL_NAME,
  describeImageToolSchema,
} from '../src/provider.ts'
import {
  analyzedPlaceholderFor,
  bridgeRequest,
  collectAnalyzedIds,
  ensureDescribeImageTool,
  imagePromptFor,
  injectSystemHint,
  stripDescribeImageTool,
  stripVisionToolRequest,
  SYSTEM_HINT_MARKER,
  systemHint,
  transformBlocks,
  transformMessages,
} from '../src/transform.ts'

const IMAGE_ID = 'sha256:feed'
const OTHER_ID = 'sha256:beef'

function imageBlock(attachmentId: string): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(attachmentId),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    },
  }
}

function userMessage(blocks: ContentBlock[]): Message {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'visual',
    model: 'text-model',
    messages: [userMessage([{ type: 'text', text: 'hello' }])],
    ...overrides,
  }
}

describe('image prompt text', () => {
  it('embeds the attachmentId verbatim for the model to copy', () => {
    expect(imagePromptFor(IMAGE_ID)).toBe(
      `The user attached an image (attachmentId: ${IMAGE_ID}). Its content is available through the describe_image tool — call it with attachmentId "${IMAGE_ID}" to get the image's text description, then answer based on it.`,
    )
  })

  it('renders the already-analyzed placeholder with the id', () => {
    expect(analyzedPlaceholderFor(IMAGE_ID)).toContain(`attachmentId: ${IMAGE_ID}`)
  })

  it('anchors the system hint on the marker line', () => {
    expect(systemHint().startsWith(SYSTEM_HINT_MARKER)).toBe(true)
    expect(systemHint()).toContain('describe_image')
  })
})

describe('transformBlocks', () => {
  it('replaces an image block with the prompt and keeps text blocks', () => {
    const out = transformBlocks([{ type: 'text', text: 'a' }, imageBlock(IMAGE_ID)], new Set())
    expect(out).not.toBeNull()
    expect(textOf(out!)).toBe(`a${imagePromptFor(IMAGE_ID)}`)
  })

  it('recurses into tool-result content', () => {
    const out = transformBlocks([
      { type: 'tool-result', toolCallId: 'c1', content: [imageBlock(IMAGE_ID)], isError: false },
    ], new Set())
    expect(out![0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1' })
    expect(textOf((out![0] as { content: ContentBlock[] }).content)).toBe(imagePromptFor(IMAGE_ID))
  })

  it('returns null when nothing changed', () => {
    expect(transformBlocks([{ type: 'text', text: 'a' }], new Set())).toBeNull()
  })

  it('uses the placeholder for an already-analyzed image', () => {
    const out = transformBlocks([imageBlock(IMAGE_ID)], new Set([IMAGE_ID]))
    expect(textOf(out!)).toBe(analyzedPlaceholderFor(IMAGE_ID))
  })
})

describe('collectAnalyzedIds', () => {
  it('collects ids from describe_image result text, recursing into tool results', () => {
    const messages = [
      userMessage([
        { type: 'text', text: `[vision-bridge: describe_image ${IMAGE_ID}] a red ball` },
      ]),
      userMessage([
        { type: 'tool-result', toolCallId: 'c1', isError: false, content: [
          { type: 'text', text: `[vision-bridge: describe_image ${OTHER_ID}] a blue cube` },
        ] },
      ]),
    ]
    expect(collectAnalyzedIds(messages)).toEqual(new Set([IMAGE_ID, OTHER_ID]))
  })

  it('collects nothing from unrelated text or prompts', () => {
    const messages = [
      userMessage([{ type: 'text', text: imagePromptFor(IMAGE_ID) }]),
      userMessage([{ type: 'text', text: 'no markers here' }]),
    ]
    expect(collectAnalyzedIds(messages)).toEqual(new Set())
  })
})

describe('transformMessages', () => {
  it('replaces images and preserves message identity, role, and source', () => {
    const message = userMessage([{ type: 'text', text: 'hi' }, imageBlock(IMAGE_ID)])
    const out = transformMessages([message])
    expect(out).not.toBeNull()
    const transformed = out![0]!
    expect(transformed.id).toBe(message.id)
    expect(transformed.role).toBe('user')
    expect(transformed.source).toBe(message.source)
    expect(transformed.content.some(block => block.type === 'image')).toBe(false)
  })

  it('reports no change (null) when no message carries an image', () => {
    expect(transformMessages([userMessage([{ type: 'text', text: 'plain' }])])).toBeNull()
  })

  it('is idempotent: a second pass over a transformed list reports no change', () => {
    const once = transformMessages([userMessage([imageBlock(IMAGE_ID)])])
    expect(once).not.toBeNull()
    expect(transformMessages(once!)).toBeNull()
  })
})

describe('injectSystemHint', () => {
  it('returns the hint alone for a system-less request', () => {
    expect(injectSystemHint(undefined)).toBe(systemHint())
  })

  it('appends the hint once to an existing prompt', () => {
    expect(injectSystemHint('base prompt')).toBe(`base prompt\n\n${systemHint()}`)
  })

  it('is idempotent once the marker line is present', () => {
    const once = injectSystemHint('base')
    expect(injectSystemHint(once)).toBe(once)
  })
})

describe('tool schema add/strip', () => {
  const schema = describeImageToolSchema()

  it('adds the schema to a tool-less request and to a request without it', () => {
    const added = ensureDescribeImageTool(undefined)
    expect(added).toEqual([schema])
    expect(ensureDescribeImageTool([{ name: 'other', description: 'd', parameters: {} }]))
      .toEqual([{ name: 'other', description: 'd', parameters: {} }, schema])
  })

  it('is idempotent when the schema is already present', () => {
    const once = ensureDescribeImageTool(undefined)
    expect(ensureDescribeImageTool(once)).toBe(once)
  })

  it('strips the schema and leaves a tool-less request unchanged', () => {
    expect(stripDescribeImageTool(undefined)).toBeUndefined()
    const stripped = stripDescribeImageTool([schema, { name: 'other', description: 'd', parameters: {} }])
    expect(stripped).toEqual([{ name: 'other', description: 'd', parameters: {} }])
    expect(stripDescribeImageTool([{ name: 'other', description: 'd', parameters: {} }]))
      .toEqual([{ name: 'other', description: 'd', parameters: {} }])
  })
})

describe('bridgeRequest', () => {
  it('builds a replacement request for an image-carrying request', () => {
    const options = baseOptions({
      messages: [userMessage([imageBlock(IMAGE_ID)])],
      system: 'base',
      tools: [{ name: 'other', description: 'd', parameters: {} }],
    })
    const out = bridgeRequest(options)
    expect(out).not.toBeNull()
    expect(out!.messages[0]!.content.some(block => block.type === 'image')).toBe(false)
    expect(out!.system).toContain(SYSTEM_HINT_MARKER)
    expect(out!.tools!.some(tool => tool.name === DESCRIBE_IMAGE_TOOL_NAME)).toBe(true)
    expect(out!.tools!.some(tool => tool.name === 'other')).toBe(true)
    // Request identity and route survive.
    expect(out!.provider).toBe('visual')
    expect(out!.model).toBe('text-model')
  })

  it('reports no change (null) when nothing needs transforming', () => {
    // "Nothing to transform" requires all three conditions: no image blocks,
    // the marker already in system, and describe_image already in tools.
    const options = baseOptions({ system: systemHint(), tools: [describeImageToolSchema()] })
    expect(bridgeRequest(options)).toBeNull()
  })

  it('turns a repeated image into a placeholder after an analysis exists', () => {
    const history = userMessage([
      { type: 'text', text: `[vision-bridge: describe_image ${IMAGE_ID}] a red ball` },
    ])
    const options = baseOptions({
      messages: [history, userMessage([imageBlock(IMAGE_ID)])],
    })
    const out = bridgeRequest(options)
    expect(textOf(out!.messages[1]!.content)).toBe(analyzedPlaceholderFor(IMAGE_ID))
  })
})

describe('stripVisionToolRequest', () => {
  it('removes only the bridge tool', () => {
    const other: ToolSchema = { name: 'other', description: 'd', parameters: {} }
    const options = baseOptions({ tools: [other, describeImageToolSchema()] })
    const out = stripVisionToolRequest(options)
    expect(out).not.toBeNull()
    expect(out!.tools).toEqual([other])
    expect(out!.messages).toBe(options.messages)
    expect(out!.system).toBe(options.system)
  })

  it('reports no change (null) when the tool is already absent', () => {
    const options = baseOptions()
    expect(stripVisionToolRequest(options)).toBeNull()
    expect(stripVisionToolRequest(baseOptions({ tools: [{ name: 'other', description: 'd', parameters: {} }] }))).toBeNull()
  })
})
