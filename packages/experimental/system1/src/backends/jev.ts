/**
 * Jev backend: hosted fast-thinking API for users who bring their own key.
 *
 * The API key is read from the environment variable named by
 * `jevApiKeyEnv` at call time and never stored. The `/v1/systemone` wire
 * shape below is provisional and must be verified against Jev's current
 * API documentation; any mismatch surfaces as a backend error and the
 * service falls back safely.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { System1Backend } from '../backend.ts'
import type {
  System1Judgment,
  System1Question,
  System1RuntimeConfig,
} from '../types.ts'

/** Backend that calls Jev's hosted System One endpoint. */
export class JevBackend implements System1Backend {
  readonly kind = 'jev' as const

  constructor(private readonly config: System1RuntimeConfig) {}

  async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
    const started = Date.now()
    const apiKey = process.env[this.config.jevApiKeyEnv]
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        `system1: Jev backend needs an API key in $${this.config.jevApiKeyEnv}`,
      )
    }
    const response = await fetch(this.config.jevEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        question: question.prompt,
        context: question.context,
        answer_schema: question.answerSchema,
      }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`jev systemone returned HTTP ${response.status}`)
    }
    // Wire shape is provisional; verify against Jev's current API docs.
    const body = (await response.json()) as {
      answer?: unknown
      confidence?: unknown
      abstained?: unknown
    }
    return {
      answer: body.answer ?? null,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0,
      latencyMs: Date.now() - started,
      backend: 'jev',
      abstained: body.abstained === true,
    }
  }

  async dispose(): Promise<void> {
    // Stateless HTTP client; nothing held.
  }
}
