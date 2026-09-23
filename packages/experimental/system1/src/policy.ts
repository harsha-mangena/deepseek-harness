/**
 * Pure actuation policies for System 1 `async` enforce mode.
 *
 * Everything here is deterministic and model-free, so it is unit-testable
 * without a backend: which verdict routes a turn, when a tool call is risky
 * enough to wait for a judgment, which hints may be injected again, and
 * which pending post-execute judgments a step still owes the model.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { TriageVerdict } from './types.ts'

const RANK: Readonly<Record<TriageVerdict, number>> = { trivial: 0, standard: 1, complex: 2 }

/** One level up; `complex` stays `complex`. */
export function escalateVerdict(verdict: TriageVerdict): TriageVerdict {
  return verdict === 'trivial' ? 'standard' : 'complex'
}

/** Whether `next` is strictly more demanding than `current`. */
export function isUpgrade(current: TriageVerdict, next: TriageVerdict): boolean {
  return RANK[next] > RANK[current]
}

/**
 * Sticky per-turn routing. The first confident verdict of a turn fixes the
 * route for every later step; later verdicts may only *upgrade* it.
 *
 * Why: DeepSeek's prefix cache is per model. Flapping Pro → Flash → Pro
 * inside one turn re-bills the whole context at cache-miss prices on every
 * switch, which erases the savings routing was meant to create. Upgrades
 * stay allowed because a failing trajectory is worth the one cache miss.
 */
export class RouteLedger {
  private readonly turns = new Map<string, { turn: number; verdict: TriageVerdict; traceId: string | null }>()

  constructor(private readonly capacity = 128) {}

  /** The turn's current verdict, or null when none was recorded for `turn`. */
  get(agentId: string, turn: number): { verdict: TriageVerdict; traceId: string | null } | null {
    const entry = this.turns.get(agentId)
    return entry !== undefined && entry.turn === turn ? { verdict: entry.verdict, traceId: entry.traceId } : null
  }

  /**
   * Offer a verdict for the turn. Returns the verdict now in force and
   * whether the offer changed it (first verdict or an upgrade).
   */
  offer(agentId: string, turn: number, verdict: TriageVerdict, traceId: string | null): { verdict: TriageVerdict; changed: boolean } {
    const entry = this.turns.get(agentId)
    if (entry === undefined || entry.turn !== turn) {
      this.turns.delete(agentId)
      this.turns.set(agentId, { turn, verdict, traceId })
      this.evict()
      return { verdict, changed: true }
    }
    if (!isUpgrade(entry.verdict, verdict)) return { verdict: entry.verdict, changed: false }
    entry.verdict = verdict
    entry.traceId = traceId
    return { verdict, changed: true }
  }

  /** Force a one-level upgrade for the turn (failure-signal escalation). */
  escalate(agentId: string, turn: number): TriageVerdict | null {
    const entry = this.turns.get(agentId)
    if (entry === undefined || entry.turn !== turn) return null
    const next = escalateVerdict(entry.verdict)
    const changed = next !== entry.verdict
    entry.verdict = next
    return changed ? next : null
  }

  /** Forget the agent (new task). */
  reset(agentId: string): void {
    this.turns.delete(agentId)
  }

  private evict(): void {
    while (this.turns.size > this.capacity) {
      const oldest = this.turns.keys().next().value
      if (oldest === undefined) break
      this.turns.delete(oldest)
    }
  }
}

/** Tool names whose dispatch is worth a blocking System 1 judgment by default. */
export const DEFAULT_RISKY_TOOL_PATTERNS: readonly string[] = [
  '^(bash|pwsh|shell|terminal)',
  '(^|_)(write|delete|remove|rm|move|rename|kill)(_|$)',
  '^mcp__',
]

/** Compile risky-tool patterns once; invalid patterns are skipped, never thrown. */
export function compileToolPatterns(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'))
    } catch {
      // An invalid operator pattern must not break the plugin; it matches nothing.
    }
  }
  return compiled
}

/** Whether a tool call is risky enough to wait for a tool-choice judgment. */
export function isRiskyTool(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(name))
}

/**
 * Whether a pre-step carries fresh input worth triaging: the first step of
 * a turn, or any step that claims new inbox messages (user steering). Empty
 * mid-turn steps are tool continuations — triaging an empty preview only
 * produces noise.
 */
export function isFreshStep(step: number, claimedMessages: number): boolean {
  return step <= 1 || claimedMessages > 0
}

/**
 * Per-turn hint ledger: the same guidance text is injected at most once per
 * agent turn, so persistent history does not accumulate duplicate
 * instructions step after step.
 */
export class HintLedger {
  private readonly seen = new Map<string, { turn: number; keys: Set<string> }>()

  constructor(private readonly capacity = 128) {}

  /** Returns true (and records it) when `hintKey` was not yet injected this turn. */
  admit(agentId: string, turn: number, hintKey: string): boolean {
    let entry = this.seen.get(agentId)
    if (entry === undefined || entry.turn !== turn) {
      this.seen.delete(agentId)
      entry = { turn, keys: new Set() }
      this.seen.set(agentId, entry)
      while (this.seen.size > this.capacity) {
        const oldest = this.seen.keys().next().value
        if (oldest === undefined) break
        this.seen.delete(oldest)
      }
    }
    if (entry.keys.has(hintKey)) return false
    entry.keys.add(hintKey)
    return true
  }

  reset(agentId: string): void {
    this.seen.delete(agentId)
  }
}

/**
 * Pending post-execute judgments per agent, in dispatch order. A step
 * drains the settled ones; unsettled ones carry over to the next step.
 */
export class PendingQueue {
  private readonly queues = new Map<string, string[]>()

  constructor(private readonly maxPerAgent = 32, private readonly capacity = 128) {}

  push(agentId: string, key: string): void {
    let queue = this.queues.get(agentId)
    if (queue === undefined) {
      queue = []
      this.queues.set(agentId, queue)
      while (this.queues.size > this.capacity) {
        const oldest = this.queues.keys().next().value
        if (oldest === undefined) break
        this.queues.delete(oldest)
      }
    }
    queue.push(key)
    while (queue.length > this.maxPerAgent) queue.shift()
  }

  list(agentId: string): readonly string[] {
    return this.queues.get(agentId) ?? []
  }

  /** Keep only `keys` still pending for the agent. */
  retain(agentId: string, keys: readonly string[]): void {
    if (keys.length === 0) this.queues.delete(agentId)
    else this.queues.set(agentId, [...keys])
  }

  reset(agentId: string): void {
    this.queues.delete(agentId)
  }
}
