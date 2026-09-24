/**
 * Jev decision provider: TypeSafe API adapter.
 *
 * Calls POST https://api.typesafe.ai/v1/systemone with the shared state,
 * pinned model, and keyed questions. Normalizes choice/score/noul responses
 * to NormalizedDecision. The API key is supplied by the caller (from the
 * Secure Vault); it is never logged or persisted by this provider.
 *
 * @module @deepseek-ai/dsh-system1-jev/jev-provider
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  DecisionInput,
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { normalizeJevResponse } from './normalize.ts'

/** Jev provider configuration. */
export interface JevProviderConfig {
  /** API key (from Secure Vault). Never logged. */
  readonly apiKey: string
  /** Pinned model ID. Must not be a mutable alias. */
  readonly model: string
  /** API base URL. Defaults to the TypeSafe endpoint. */
  readonly baseUrl?: string
  /** Request timeout in milliseconds. Defaults to 30s. */
  readonly timeoutMs?: number
  /** Max transport retries. Defaults to 1 (per plan §8). */
  readonly maxTransportRetries?: number
  /** Fetch implementation (injectable for tests). */
  readonly fetchFn?: typeof fetch
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TRANSPORT_RETRIES = 1

/** Extract the code if this is a non-retryable System1Error. */
export function nonRetryableCode(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'System1Error') {
    const code = (error as { code?: string }).code
    if (code === 'TASK_CANCELLED' || code === 'PROVIDER_MALFORMED_RESPONSE') {
      return code
    }
  }
  return undefined
}

/** A Jev decision provider over the TypeSafe API. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly config: Required<Omit<JevProviderConfig, 'apiKey'>> & { apiKey: string }

  /**
   * @param config - provider configuration.
   */
  constructor(config: JevProviderConfig) {
    if (!config.apiKey) {
      throw system1Error('PROVIDER_TRANSPORT_FAILED', 'Jev API key is required', {})
    }
    if (!config.model) {
      throw system1Error('PROVIDER_UNSUPPORTED_MODEL', 'Jev model must be pinned', {})
    }
    this.config = {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxTransportRetries: config.maxTransportRetries ?? DEFAULT_MAX_TRANSPORT_RETRIES,
      fetchFn: config.fetchFn ?? fetch,
    }
  }

  async decide(input: DecisionInput, signal: AbortSignal): Promise<NormalizedDecision> {
    // Map candidates to a single choice question. The options are candidate
    // IDs; labels are included for the model's context but the response must
    // contain a valid candidate ID.
    const options = input.candidates.map((c) => c.id)
    const optionLabels = input.candidates.map((c) => `${c.id}: ${c.label}`).join('\n')

    const requestBody = {
      state: input.state,
      model: this.config.model,
      questions: {
        'select-candidate': {
          type: 'choice',
          question: `Which candidate should be selected for task ${input.taskId}?\n${optionLabels}`,
          options,
        },
      },
    }

    const url = `${this.config.baseUrl}/v1/systemone`

    // Retry loop: always returns or throws; no fallthrough.
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) {
        throw system1Error('TASK_CANCELLED', 'Jev decision request was cancelled', {
          decisionId: input.decisionId,
        })
      }
      try {
        const response = await this.fetchWithTimeout(url, requestBody, signal)
        return normalizeJevResponse(response, input, this.config.model)
      } catch (error) {
        // Don't retry contract violations or cancellations.
        if (nonRetryableCode(error) !== undefined) {
          throw error
        }
        // Retry on transport failures; otherwise throw.
        if (attempt >= this.config.maxTransportRetries) {
          throw error
        }
      }
    }
  }

  /** POST with timeout and auth. */
  private async fetchWithTimeout(
    url: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    // Combine the caller's signal with the timeout.
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.config.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const status = response.status
        if (status === 429) {
          throw system1Error('PROVIDER_RATE_LIMITED', `Jev rate limited (HTTP ${status})`, { status })
        }
        if (status === 401 || status === 403) {
          throw system1Error('PROVIDER_TRANSPORT_FAILED', `Jev auth failed (HTTP ${status})`, { status })
        }
        throw system1Error('PROVIDER_TRANSPORT_FAILED', `Jev request failed (HTTP ${status})`, {
          status,
        })
      }
      return (await response.json()) as unknown
    } catch (error) {
      if (error instanceof Error && error.name === 'System1Error') throw error
      if (controller.signal.aborted && signal.aborted) {
        throw system1Error('TASK_CANCELLED', 'Jev decision request was cancelled', {})
      }
      if (controller.signal.aborted) {
        throw system1Error('PROVIDER_TIMEOUT', 'Jev request timed out', {
          timeoutMs: this.config.timeoutMs,
        })
      }
      throw system1Error('PROVIDER_TRANSPORT_FAILED', 'Jev transport failed', {
        cause: String(error),
      })
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
