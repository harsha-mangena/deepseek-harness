/**
 * Orchestrator-level System 1: judge-before-delegate for team delegation.
 *
 * The agent-level hooks (pre-step triage, post-execute loop/retry) see one
 * agent's step history. Delegation decisions — the Lead spawning a teammate
 * via `spawn_teammate` — are an orchestration concern: the quality of the
 * delegation, duplicate or overlapping spawns, and the reasoning strategy
 * the subtask deserves. This module implements that layer.
 *
 * Design constraints from the harness seams:
 * - `tools/pre-execute` can only allow/deny/cancel/ask; argument rewriting is
 *   deliberately excluded, so the teammate's birth prompt cannot be edited.
 *   The strategy hint still reaches the teammate: it is an agent like any
 *   other, so its first pre-step is triaged by the agent-level hook and gets
 *   the atom/chain/tree-of-thoughts hint there.
 * - What the orchestrator layer *can* do is judge the delegation itself and
 *   advise the Lead through `additionalContexts` on the `spawn_teammate`
 *   result: a triage advisory (what the subtask needs, how to oversee it)
 *   and a deterministic duplicate-purpose warning.
 * - The branch only fires for the `spawn_teammate` tool, which only exists
 *   when the agent-team packages are installed — without them this module
 *   is inert, no config flag needed.
 *
 * Like the agent level, every actuation is gated: confident verdicts only,
 * bounded registry, and any fallback resolves to "no injection".
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { buildDelegationScoreQuestions, validateDelegationScore } from './gates.ts'
import type {
  DelegationScores,
  DelegationWeights,
  OversightJudgment,
} from './types.ts'

/** Default weights for the delegation composite (relative; normalized in code). */
export const DEFAULT_DELEGATION_WEIGHTS: DelegationWeights = {
  novelty: 0.4,
  toolRisk: 0.35,
  irreversibility: 0.25,
}

/**
 * Combine atomic delegation scores into an oversight judgment — TypeSafe's
 * composite-scoring pattern: normalize the weights so they need not sum to
 * 1, weight each 0..3 score into 0..1, and tier the result. Higher weight on
 * novelty because an exploring teammate is the main oversight risk; weight
 * changes shift policy without a prompt rewrite.
 */
export function computeDelegationOversight(
  scores: DelegationScores,
  weights: DelegationWeights = DEFAULT_DELEGATION_WEIGHTS,
): OversightJudgment {
  const total = weights.novelty + weights.toolRisk + weights.irreversibility
  if (!(total > 0)) throw new Error('system1: delegation weights must be positive')
  const maxLevel = 3 // DELEGATION_LEVELS - 1: score answers run 0..3
  const score = (
    weights.novelty * (scores.novelty / maxLevel) +
    weights.toolRisk * (scores.toolRisk / maxLevel) +
    weights.irreversibility * (scores.irreversibility / maxLevel)
  ) / total
  const level = score < 0.35 ? 'low' : score < 0.65 ? 'standard' : 'high'
  return { level, score, scores }
}

/** Tool name the Lead calls to delegate; the orchestrator hook key. */
export const SPAWN_TOOL_NAME = 'spawn_teammate'

/** Max delegation records kept; bounds memory for long-running sessions. */
export const MAX_SPAWNS = 32

/** How long a past spawn counts for duplicate detection (30 minutes). */
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000

/** Jaccard similarity at or above which two purposes count as duplicates. */
export const DUPLICATE_SIMILARITY = 0.5

const STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'to', 'and', 'or', 'in', 'on',
  'with', 'by', 'is', 'are', 'be', 'as', 'at', 'from', 'this', 'that', 'it',
])

/** Lowercase alphanumeric word set, minus stopwords. */
function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 0 && !STOPWORDS.has(token)) out.add(token)
  }
  return out
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** One recorded teammate spawn, for duplicate-purpose detection. */
export interface DelegationRecord {
  readonly name: string
  readonly description: string
  readonly at: number
}

/**
 * A Jev-scored delegation composite, cached so an identical spawn reuses
 * the advisory instead of spending another backend round-trip on
 * byte-identical questions. The scores are Jev's; the reuse only skips the
 * redundant re-ask.
 */
export interface DelegationScoreCache {
  readonly scores: DelegationScores
  readonly oversight: OversightJudgment
  /** Null when the oversight tier needs no commentary (low). */
  readonly advisory: string | null
}

/**
 * Bounded registry of recent teammate spawns. Duplicate detection compares
 * a new delegation against spawns inside the time window; the registry
 * never grows past `maxSpawns`, so long sessions cannot leak memory. It is
 * deliberately not coupled to agent turns: a duplicate purpose is worth
 * flagging even across task boundaries, and the time window keeps stale
 * entries from warning forever.
 */
export function createDelegationState(
  maxSpawns: number = MAX_SPAWNS,
  windowMs: number = DUPLICATE_WINDOW_MS,
): {
  /** Record a successful spawn; evicts the oldest past `maxSpawns`. */
  noteSpawn(name: string, description: string): void
  /**
   * Find a recent spawn with the same normalized name or a similar purpose,
   * or null. Call BEFORE `noteSpawn` for the candidate, or the candidate
   * matches itself.
   */
  findDuplicate(name: string, description: string): DelegationRecord | null
  /** Current registry size; exported for tests. */
  size(): number
  /**
   * Cache the Jev-scored composite for a spawn's canonical args key, so a
   * repeated identical delegation — including a looping one, which returns
   * before the scoring batch is built — still receives the advisory without
   * a redundant backend round-trip. Bounded like the registry.
   */
  noteScores(argsKey: string, cached: DelegationScoreCache): void
  /** Reuse the cached composite for identical args, or null when unscored. */
  takeScores(argsKey: string): DelegationScoreCache | null
} {
  const spawns: DelegationRecord[] = []
  const scoreCache = new Map<string, DelegationScoreCache>()
  return {
    noteSpawn(name: string, description: string): void {
      spawns.push({ name, description, at: Date.now() })
      while (spawns.length > Math.max(1, maxSpawns)) spawns.shift()
    },
    findDuplicate(name: string, description: string): DelegationRecord | null {
      const candidate = words(`${name} ${description}`)
      if (candidate.size === 0) return null
      const now = Date.now()
      const normalized = normalizeName(name)
      for (let index = spawns.length - 1; index >= 0; index -= 1) {
        const existing = spawns[index] as DelegationRecord
        if (now - existing.at > windowMs) continue
        if (normalized.length > 0 && normalizeName(existing.name) === normalized) return existing
        if (jaccard(candidate, words(`${existing.name} ${existing.description}`)) >= DUPLICATE_SIMILARITY) {
          return existing
        }
      }
      return null
    },
    size(): number {
      return spawns.length
    },
    noteScores(argsKey: string, cached: DelegationScoreCache): void {
      scoreCache.set(argsKey, cached)
      while (scoreCache.size > Math.max(1, maxSpawns)) {
        const oldest = scoreCache.keys().next().value
        /* v8 ignore next -- defensive: a non-empty map always has a first key */
        if (oldest === undefined) break
        scoreCache.delete(oldest)
      }
    },
    takeScores(argsKey: string): DelegationScoreCache | null {
      return scoreCache.get(argsKey) ?? null
    },
  }
}

/** Delegated subtask details extracted from a `spawn_teammate` call. */
export interface SpawnArgs {
  readonly name: string
  readonly description: string
  readonly prompt: string
}

/**
 * Defensively extract spawn arguments from tool arguments. Returns null for
 * anything malformed — the delegation path then falls back to the normal
 * tool handling instead of crashing the waterfall.
 */
export function extractSpawnArgs(args: unknown): SpawnArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const record = args as Record<string, unknown>
  const { name, description, prompt } = record
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof description !== 'string' || description.length === 0) return null
  if (typeof prompt !== 'string' || prompt.length === 0) return null
  return { name, description, prompt }
}

/**
 * Build the delegation triage questions: three atomic Score questions —
 * novelty, tool risk, irreversibility — evaluated in parallel and combined
 * with weights into an oversight judgment ({@link computeDelegationOversight}).
 * A single Choice hiding several judgments is a documented anti-pattern;
 * atomic scores keep each judgment one-dimensional and let weight changes
 * shift policy without a prompt rewrite. The questions are built in
 * gates.ts, where the other builders live; this re-export keeps the
 * orchestrator surface in one place.
 */
export const buildDelegationTriageQuestions = buildDelegationScoreQuestions

/**
 * Validate one raw delegation score into a 0..3 position (see
 * {@link validateDelegationScore}). Out-of-range answers fail validation
 * rather than clamping: a miscalibrated score must not silently become a
 * confident one.
 */
export const validateDelegationTriage = validateDelegationScore

/**
 * Lead-facing advisory for a delegation oversight judgment. Returns null for
 * `low` oversight: a routine delegation needs no commentary, so the Lead's
 * context stays clean. Standard/high advisories restate the driving scores
 * so the Lead can see *why* the tier was assigned.
 */
export function buildDelegationAdvisory(name: string, oversight: OversightJudgment): string | null {
  if (oversight.level === 'low') return null
  const { novelty, toolRisk, irreversibility } = oversight.scores
  const scored = `novelty ${novelty.toFixed(1)}/3, tool risk ${toolRisk.toFixed(1)}/3, irreversibility ${irreversibility.toFixed(1)}/3`
  if (oversight.level === 'standard') {
    return `[System 1 delegation: standard oversight] Teammate "${name}" takes a moderately demanding subtask (${scored}). It will receive a grounded chain-of-thought strategy hint on its first step; normal oversight applies.`
  }
  return `[System 1 delegation: high oversight] Teammate "${name}" takes a demanding subtask (${scored}). It will receive an atomic-decomposition strategy hint on its first step. Ask it to lay out its plan before committing, and check its early output before stacking dependent work on it.`
}

/** Lead-facing warning when a spawn duplicates a recent teammate's purpose. */
export function buildDuplicateWarning(name: string, existing: DelegationRecord): string {
  const ageMinutes = Math.max(1, Math.round((Date.now() - existing.at) / 60000))
  return `[System 1 delegation] Teammate "${name}" overlaps with teammate "${existing.name}" (spawned ~${ageMinutes}m ago for a similar purpose: "${existing.description.slice(0, 160)}"). Consider interrupting the duplicate or merging their scopes before both burn tokens on the same work.`
}
