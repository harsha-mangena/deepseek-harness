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

import type { System1Question, TriageVerdict } from './types.ts'

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
} {
  const spawns: DelegationRecord[] = []
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
 * Build a triage question over a delegation: how much reasoning does the
 * delegated subtask deserve? Uses the same verdict vocabulary as step
 * triage (`trivial`/`standard`/`complex`) so the verdict reuses the
 * atom/chain/tree-of-thoughts strategy hints — the teammate, being an
 * agent, receives the matching hint on its first pre-step.
 */
export function buildDelegationTriageQuestion(
  name: string,
  description: string,
  prompt: string,
): System1Question {
  return {
    kind: 'delegation-triage',
    primitive: 'choice',
    prompt: 'How much reasoning does this delegated subtask need?',
    context: {
      delegation: {
        name: name.slice(0, 120),
        description: description.slice(0, 500),
      },
      promptPreview: prompt.slice(0, 1000),
    },
    options: {
      trivial: 'Routine subtask; the teammate can execute it directly with minimal deliberation',
      standard: 'Normal subtask; the teammate should proceed with default step-by-step reasoning',
      complex: 'Demanding subtask; the teammate needs full reasoning — atomic sub-steps and alternative approaches',
    },
  }
}

/**
 * Lead-facing advisory for a confident delegation triage. Returns null for
 * `trivial`: a routine delegation needs no commentary, so the Lead's
 * context stays clean. `standard`/`complex` advisories name the strategy
 * the teammate will receive and suggest proportionate oversight.
 */
export function buildDelegationAdvisory(name: string, verdict: TriageVerdict): string | null {
  switch (verdict) {
    case 'trivial':
      return null
    case 'standard':
      return `[System 1 delegation triage: standard] Teammate "${name}" takes on a standard subtask. It will receive a chain-of-thoughts strategy hint (normal step-by-step reasoning) on its first step; normal oversight applies.`
    case 'complex':
      return `[System 1 delegation triage: complex] Teammate "${name}" takes on a complex subtask. It will receive a tree-of-thoughts strategy hint (atomic sub-steps, 2–3 candidate approaches before committing) on its first step. Consider asking it to lay out its candidate approaches before it commits, and check its early output before stacking dependent work on it.`
  }
}

/** Lead-facing warning when a spawn duplicates a recent teammate's purpose. */
export function buildDuplicateWarning(name: string, existing: DelegationRecord): string {
  const ageMinutes = Math.max(1, Math.round((Date.now() - existing.at) / 60000))
  return `[System 1 delegation] Teammate "${name}" overlaps with teammate "${existing.name}" (spawned ~${ageMinutes}m ago for a similar purpose: "${existing.description.slice(0, 160)}"). Consider interrupting the duplicate or merging their scopes before both burn tokens on the same work.`
}
