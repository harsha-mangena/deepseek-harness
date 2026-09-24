/**
 * Context selection and memory.
 *
 * Working memory: per-task short-term storage (observations, decisions).
 * Context selection: relevance-scored selection with character budgeting.
 * Long-term memory is out of scope (host provides via observations).
 *
 * @module @deepseek-ai/dsh-system1-memory/memory
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

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
   * Store an entry.
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

    // Enforce character limit (drop oldest until under limit).
    let totalChars = taskEntries.reduce((sum, e) => sum + e.content.length, 0)
    while (taskEntries.length > 0 && totalChars + content.length > this.maxChars) {
      // length > 0 guarantees shift() returns an element.
      const removed = taskEntries.shift() as MemoryEntry
      totalChars -= removed.content.length
    }

    const entry: MemoryEntry = {
      id: this.newEntryId(),
      taskId,
      kind,
      content,
      timestampMs,
      relevance: 1.0,
    }
    taskEntries.push(entry)
    this.entries.set(taskId, taskEntries)
    return entry
  }

  /**
   * Retrieve entries for a task.
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
   * @param entries - memory entries.
   * @param query - query for relevance (currently recency-based).
   * @returns selected context string (bounded).
   */
  select(entries: readonly MemoryEntry[], _query: string): string {
    // Score: recency (newer = higher) + kind boost (decisions > observations > notes).
    const scored = entries.map((entry) => {
      const kindBoost = entry.kind === 'decision' ? 0.3 : entry.kind === 'observation' ? 0.2 : 0.1
      // Recency: normalize by max timestamp.
      const maxTs = Math.max(...entries.map((e) => e.timestampMs), 1)
      const recency = entry.timestampMs / maxTs
      return { entry, score: recency * 0.7 + kindBoost }
    })

    // Sort by score descending.
    scored.sort((a, b) => b.score - a.score)

    // Take until char budget.
    const selected: string[] = []
    let chars = 0
    for (const { entry } of scored) {
      const text = `[${entry.kind}] ${entry.content}`
      if (chars + text.length > this.maxChars && selected.length > 0) break
      selected.push(text)
      chars += text.length
      // Account for separator.
      chars += 2
    }

    return selected.join('\n\n')
  }
}
