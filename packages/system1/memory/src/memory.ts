/**
 * Context selection and memory.
 *
 * Working memory: per-task short-term storage (observations, decisions).
 * Context selection: relevance-scored selection with character budgeting.
 * Long-term memory is out of scope (host provides via observations).
 *
 * All character budgets in this module count Unicode code points, not UTF-16
 * code units or bytes, and truncation never splits a surrogate pair.
 *
 * @module @deepseek-ai/dsh-system1-memory/memory
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

/** Marker appended when content is shortened to fit a character budget. */
const TRUNCATION_MARKER = '...[TRUNCATED]'

/**
 * Count Unicode code points (characters), not UTF-16 code units.
 * @param text - text to measure.
 * @returns number of characters.
 */
function countChars(text: string): number {
  return Array.from(text).length
}

/**
 * Truncate text to a character budget, reserving space for the truncation
 * marker so the returned text never exceeds the budget. When the budget is
 * smaller than the marker, the marker itself is cut to the budget so
 * truncation stays visible.
 * @param text - text to truncate.
 * @param maxChars - maximum characters in the returned text; must be >= 0.
 * @returns text bounded to maxChars characters.
 */
function truncateToBudget(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) {
    return text
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return Array.from(TRUNCATION_MARKER).slice(0, maxChars).join('')
  }
  return chars.slice(0, maxChars - TRUNCATION_MARKER.length).join('') + TRUNCATION_MARKER
}

/** A memory entry with provenance. */
export interface MemoryEntry {
  readonly id: string
  readonly taskId: string
  readonly kind: 'observation' | 'decision' | 'note'
  readonly content: string
  readonly timestampMs: number
  /** Relevance score (0-1), set by selector. */
  readonly relevance: number
}

/** Working memory configuration. */
export interface WorkingMemoryConfig {
  /** Maximum entries per task. Defaults to 100. */
  readonly maxEntriesPerTask?: number
  /** Maximum total characters per task. Defaults to 32_000. */
  readonly maxCharsPerTask?: number
  /** Entry ID generator. */
  readonly newEntryId: () => string
}

/** Per-task working memory. */
export class WorkingMemory {
  private readonly maxEntries: number
  private readonly maxChars: number
  private readonly newEntryId: () => string
  private readonly entries = new Map<string, MemoryEntry[]>()

  /**
   * @param config - working memory configuration.
   */
  constructor(config: WorkingMemoryConfig) {
    this.maxEntries = config.maxEntriesPerTask ?? 100
    this.maxChars = config.maxCharsPerTask ?? 32_000
    this.newEntryId = config.newEntryId
  }

  /**
   * Store an entry, enforcing the per-task budgets.
   *
   * Evicts the oldest entries first until the new entry fits. When a single
   * entry is larger than the whole character budget, the entry is kept but
   * its content is truncated to the budget with a truncation marker, so
   * `retrieve` never returns more than `maxCharsPerTask` characters.
   * @param taskId - task ID.
   * @param kind - entry kind.
   * @param content - entry content.
   * @param timestampMs - timestamp.
   * @returns the stored entry.
   */
  store(
    taskId: string,
    kind: MemoryEntry['kind'],
    content: string,
    timestampMs: number,
  ): MemoryEntry {
    const taskEntries = this.entries.get(taskId) ?? []

    // Enforce entry limit (drop oldest).
    while (taskEntries.length >= this.maxEntries) {
      taskEntries.shift()
    }

    // Enforce character limit (drop oldest until the new entry fits).
    const contentChars = countChars(content)
    let totalChars = taskEntries.reduce((sum, e) => sum + countChars(e.content), 0)
    while (taskEntries.length > 0 && totalChars + contentChars > this.maxChars) {
      // length > 0 guarantees shift() returns an element.
      const removed = taskEntries.shift() as MemoryEntry
      totalChars -= countChars(removed.content)
    }

    const entry: MemoryEntry = {
      id: this.newEntryId(),
      taskId,
      kind,
      content: truncateToBudget(content, this.maxChars),
      timestampMs,
      relevance: 1.0,
    }
    taskEntries.push(entry)
    this.entries.set(taskId, taskEntries)
    return entry
  }

  /**
   * Retrieve entries for a task.
   *
   * The returned entries total at most `maxCharsPerTask` characters: the
   * bound is enforced at store time (oldest evicted first, oversized newest
   * entry truncated with a marker).
   * @param taskId - task ID.
   * @returns entries in insertion order.
   */
  retrieve(taskId: string): readonly MemoryEntry[] {
    return this.entries.get(taskId) ?? []
  }

  /**
   * Clear entries for a task.
   * @param taskId - task ID.
   */
  clear(taskId: string): void {
    this.entries.delete(taskId)
  }
}

/** Context selection configuration. */
export interface ContextSelectorConfig {
  /** Maximum characters in selected context. Defaults to 8_000. */
  readonly maxChars?: number
}

/** Selects relevant context from memory. */
export class ContextSelector {
  private readonly maxChars: number

  /**
   * @param config - selector configuration.
   */
  constructor(config: ContextSelectorConfig = {}) {
    this.maxChars = config.maxChars ?? 8_000
    if (this.maxChars < 1) {
      throw system1Error('SCHEMA_VALIDATION_FAILED', 'maxChars must be positive', {
        maxChars: this.maxChars,
      })
    }
  }

  /**
   * Select context from entries, scored by recency and kind.
   *
   * The returned string never exceeds `maxChars` characters, separators
   * included. Entries that fit whole are kept verbatim; the first entry
   * that does not fit is truncated to the remaining budget with a
   * truncation marker (an oversized single entry is therefore shortened,
   * never dropped silently), and selection stops there.
   * @param entries - memory entries.
   * @param query - query for relevance (currently recency-based).
   * @returns selected context string (bounded).
   */
  select(entries: readonly MemoryEntry[], _query: string): string {
    // Score: recency (newer = higher) + kind boost (decisions > observations > notes).
    const scored = entries.map((entry) => {
      const kindBoost = entry.kind === 'decision' ? 0.3 : entry.kind === 'observation' ? 0.2 : 0.1
      // Recency: normalize by max timestamp.
      const maxTs = Math.max(...entries.map(e => e.timestampMs), 1)
      const recency = entry.timestampMs / maxTs
      return { entry, score: recency * 0.7 + kindBoost }
    })

    // Sort by score descending.
    scored.sort((a, b) => b.score - a.score)

    // Render within the character budget, counting separators.
    const separator = '\n\n'
    const rendered: string[] = []
    let usedChars = 0
    for (const { entry } of scored) {
      const text = `[${entry.kind}] ${entry.content}`
      const full = (rendered.length === 0 ? '' : separator) + text
      if (usedChars + countChars(full) <= this.maxChars) {
        rendered.push(full)
        usedChars += countChars(full)
        continue
      }
      const remaining = this.maxChars - usedChars
      if (remaining > 0) {
        rendered.push(truncateToBudget(full, remaining))
      }
      break
    }

    return rendered.join('')
  }
}
