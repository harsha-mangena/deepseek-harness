/**
 * Jev decision provider: TypeSafe API adapter.
 *
 * Calls POST https://api.typesafe.ai/v1/systemone with the shared state,
 * pinned model, and keyed questions. Normalizes choice/score/noul responses
 * to NormalizedDecision. The API key is supplied by the caller (from the
 * Secure Vault); it is never logged or persisted by this provider.
 *
 * Retry policy: transient failures (HTTP 429, 5xx, network/timeout errors)
 * are retried up to maxTransportRetries. Permanent failures are never
 * retried: invalid credentials (401/403) make exactly one HTTP attempt,
 * other 4xx rejections, malformed responses, and cancellations likewise
 * throw immediately. The model must be a pinned `jev-x.y.z` version;
 * mutable aliases such as `jev-latest` are rejected at construction.
 *
 * @module @deepseek-ai/dsh-system1-jev/jev-provider
 */

import { System1Error, system1Error } from '@deepseek-ai/dsh-system1-contracts'
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
  /** Pinned model ID (`jev-x.y.z`). Mutable aliases are rejected. */
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

/**
 * Pinned Jev model IDs carry an explicit version (for example `jev-1.13.0`).
 * Mutable aliases such as `jev-latest` are rejected so the resolved model
 * can never silently change under recorded decisions and calibration.
 */
const PINNED_MODEL_PATTERN = /^jev-\d+\.\d+\.\d+$/

/**
 * Extract the code if this is a non-retryable System1Error.
 *
 * Cancellations, malformed responses, and errors whose retry taxonomy is
 * 'none' (for example permanent auth failures) are never retried.
 * @param error - the caught error.
 * @returns the System1 error code, or undefined when a retry is allowed.
 */
export function nonRetryableCode(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'System1Error') {
    const code = (error as { code?: string }).code
    const retryClass = (error as { retryClass?: string }).retryClass
    if (
      code === 'TASK_CANCELLED' ||
      code === 'PROVIDER_MALFORMED_RESPONSE' ||
      retryClass === 'none'
    ) {
      return code
    }
  }
  return undefined
}

/**
 * Validate the decision input fields the request body is built from.
 * Response wire validation lives in normalizeJevResponse; this guards
 * request construction only.
 * @param input - the decision input to send.
 * @throws System1Error SCHEMA_VALIDATION_FAILED when required fields are missing.
 */
function validateDecisionInput(input: DecisionInput): void {
  if (!input.questionFamily) {
    throw system1Error('SCHEMA_VALIDATION_FAILED', 'Decision input has no question family', {
      decisionId: input.decisionId,
    })
  }
  if (input.candidates.length === 0) {
    throw system1Error('SCHEMA_VALIDATION_FAILED', 'Decision input has no candidates', {
      decisionId: input.decisionId,
    })
  }
  for (const candidate of input.candidates) {
    if (!candidate.id || !candidate.label) {
      throw system1Error('SCHEMA_VALIDATION_FAILED', 'Decision candidate needs an id and label', {
        decisionId: input.decisionId,
        candidate,
      })
    }
  }
}

/** A Jev decision provider over the TypeSafe API. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly config: Required<Omit<JevProviderConfig, 'apiKey'>> & { apiKey: string }

  /**
   * @param config - provider configuration.
   * @throws System1Error PROVIDER_TRANSPORT_FAILED when no API key is supplied.
   * @throws System1Error PROVIDER_UNSUPPORTED_MODEL when the model is missing
   * or is a mutable alias instead of a pinned `jev-x.y.z` version.
   */
  constructor(config: JevProviderConfig) {
    if (!config.apiKey) {
      throw system1Error('PROVIDER_TRANSPORT_FAILED', 'Jev API key is required', {})
    }
    if (!config.model) {
      throw system1Error('PROVIDER_UNSUPPORTED_MODEL', 'Jev model must be pinned', {})
    }
    if (!PINNED_MODEL_PATTERN.test(config.model)) {
      throw system1Error(
        'PROVIDER_UNSUPPORTED_MODEL',
        `Jev model must be a pinned version (for example jev-1.13.0), not a mutable alias: ${config.model}`,
        { model: config.model },
      )
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
    validateDecisionInput(input)
    // Map candidates to a single choice question keyed by the question
    // family. The criteria map option IDs to labels for the model's context;
    // the response must contain a valid candidate ID. This matches the
    // documented TypeSafe wire format (instructions + criteria).
    const questionId = input.questionFamily
    const criteria: Record<string, string> = {}
    for (const c of input.candidates) {
      criteria[c.id] = c.label
    }

    const requestBody = {
      state: input.state,
      model: this.config.model,
      questions: {
        [questionId]: {
          type: 'choice',
          instructions: `Which candidate should be selected for task ${input.taskId}?`,
          criteria,
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
        if (status === 401 || status === 403) {
          // Permanent: invalid credentials never heal on retry, so exactly
          // one HTTP attempt is made. retryClass 'none' keeps the transport
          // retry loop out.
          throw new System1Error(
            'PROVIDER_TRANSPORT_FAILED',
            `Jev auth failed (HTTP ${status})`,
            { retryClass: 'none', details: { status } },
          )
        }
        if (status === 429) {
          throw system1Error('PROVIDER_RATE_LIMITED', `Jev rate limited (HTTP ${status})`, { status })
        }
        if (status >= 400 && status < 500) {
          // Other client errors are permanent request rejections.
          throw new System1Error(
            'PROVIDER_TRANSPORT_FAILED',
            `Jev request rejected (HTTP ${status})`,
            { retryClass: 'none', details: { status } },
          )
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
