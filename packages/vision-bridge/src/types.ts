/**
 * Wire types for the OpenAI-compatible vision endpoint
 * (`POST {baseURL}/chat/completions`) the vision bridge calls to turn one
 * user-uploaded image into a text description. Types only — no runtime code.
 *
 * @module @dsh-plugins/vision-bridge/types
 */

/** One model-facing content part inside the user message of a chat completion. */
export type VisionChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Request body sent to the vision endpoint's chat completions operation. */
export interface VisionChatCompletionRequest {
  /** Vision model id (e.g. `gemini-3.6-flash`). */
  model: string
  /** Single user message carrying the describe prompt beside the data-URL image. */
  messages: [{ role: 'user'; content: VisionChatContentPart[] }]
  /** Optional reasoning-strength hint for models that support it (`low|medium|high`). */
  reasoning_effort?: 'low' | 'medium' | 'high'
}

/** Minimal chat-completion response envelope the bridge consumes. */
export interface VisionChatCompletionResponse {
  choices?: Array<{
    message?: {
      /** Text description produced by the vision model. */
      content?: string | null
    }
  }>
}
