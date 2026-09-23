/**
 * Laya backend: zero-configuration local fast-thinking model.
 *
 * NOTE: Laya is currently deferred — Jev is the primary backend (see
 * README). This adapter is kept compiling for a future local-first pass.
 *
 * Laya runs as a local sidecar (see {@link startLayaSidecar}), so this backend
 * needs no API key. The wire shape below is provisional and must be verified
 * against the installed Laya version; any mismatch surfaces as a backend
 * error and the service falls back safely.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { decideManySequential, type System1Backend } from '../backend.ts'
import { startLayaSidecar, type LayaSidecar } from '../sidecar.ts'
import type {
  System1Judgment,
  System1Question,
  System1RuntimeConfig,
} from '../types.ts'

/** Minimal host logger surface used by the backend. */
export interface BackendLogger {
  warn(message: string, ...args: unknown[]): void
}

/**
 * Backend that asks a local Laya sidecar. The sidecar is started lazily on
 * the first `decide` call so merely loading the plugin never spawns a
 * process.
 */
export class LayaBackend implements System1Backend {
  readonly kind = 'laya' as const
  private sidecar: LayaSidecar | null = null
  private baseUrl: string | null = null
  private startAttempt: Promise<string> | null = null

  constructor(
    private readonly config: System1RuntimeConfig,
    private readonly logger: BackendLogger,
  ) {}

  private ensureStarted(): Promise<string> {
    if (this.baseUrl !== null) return Promise.resolve(this.baseUrl)
    if (this.startAttempt === null) {
      const sidecar = startLayaSidecar(this.config.layaCommand, this.logger)
      this.sidecar = sidecar
      this.startAttempt = sidecar.ready.then((url) => {
        this.baseUrl = url
        return url
      })
    }
    return this.startAttempt
  }

  async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
    const started = Date.now()
    const url = this.config.layaAutoStart
      ? await this.ensureStarted()
      : this.config.layaEndpoint.replace(/\/decide$/, '')
    const response = await fetch(`${url}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: question.kind,
        primitive: question.primitive,
        prompt: question.prompt,
        context: question.context,
        options: question.options ?? null,
        levels: question.levels ?? null,
      }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`laya sidecar returned HTTP ${response.status}`)
    }
    // Wire shape is provisional; verify against the installed Laya version.
    const body = (await response.json()) as {
      answer?: unknown
      confidence?: unknown
      abstained?: unknown
    }
    return {
      answer: body.answer ?? null,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0,
      latencyMs: Date.now() - started,
      backend: 'laya',
      abstained: body.abstained === true,
    }
  }

  async decideMany(
    questions: readonly System1Question[],
    signal: AbortSignal,
  ): Promise<System1Judgment[]> {
    // No native batching on the sidecar contract; ask in turn.
    return decideManySequential(this, questions, signal)
  }

  async dispose(): Promise<void> {
    await this.sidecar?.stop().catch(() => undefined)
    this.sidecar = null
    this.baseUrl = null
    this.startAttempt = null
  }
}
