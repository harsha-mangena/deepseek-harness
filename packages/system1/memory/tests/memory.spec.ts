/** Memory tests. */

import { describe, expect, it } from 'vitest'
import { WorkingMemory, ContextSelector } from '@deepseek-ai/dsh-system1-memory'

describe('WorkingMemory', () => {
  it('stores and retrieves entries', () => {
    const memory = new WorkingMemory({ newEntryId: () => 'e1' })
    const entry = memory.store('task1', 'observation', 'CI is green', 1000)
    expect(entry.id).toBe('e1')
    expect(entry.taskId).toBe('task1')

    const entries = memory.retrieve('task1')
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe('CI is green')
  })

  it('returns empty for unknown task', () => {
    const memory = new WorkingMemory({ newEntryId: () => 'e' })
    expect(memory.retrieve('unknown')).toEqual([])
  })

  it('enforces entry limit (drops oldest)', () => {
    let id = 0
    const memory = new WorkingMemory({
      newEntryId: () => `e${++id}`,
      maxEntriesPerTask: 2,
    })
    memory.store('t', 'note', 'first', 1)
    memory.store('t', 'note', 'second', 2)
    memory.store('t', 'note', 'third', 3)

    const entries = memory.retrieve('t')
    expect(entries).toHaveLength(2)
    expect(entries[0].content).toBe('second')
    expect(entries[1].content).toBe('third')
  })

  it('enforces character limit (drops oldest)', () => {
    let id = 0
    const memory = new WorkingMemory({
      newEntryId: () => `e${++id}`,
      maxCharsPerTask: 10,
    })
    memory.store('t', 'note', '12345', 1) // 5 chars
    memory.store('t', 'note', '67890', 2) // 5 chars, total 10
    memory.store('t', 'note', 'abc', 3) // would be 13, drop oldest

    const entries = memory.retrieve('t')
    expect(entries.map(e => e.content)).toEqual(['67890', 'abc'])
  })

  it('clears task entries', () => {
    const memory = new WorkingMemory({ newEntryId: () => 'e' })
    memory.store('t', 'note', 'x', 1)
    memory.clear('t')
    expect(memory.retrieve('t')).toEqual([])
  })

  it('isolates tasks', () => {
    const memory = new WorkingMemory({ newEntryId: () => 'e' })
    memory.store('t1', 'note', 'one', 1)
    memory.store('t2', 'note', 'two', 2)
    expect(memory.retrieve('t1')).toHaveLength(1)
    expect(memory.retrieve('t2')).toHaveLength(1)
  })
})

describe('ContextSelector', () => {
  it('selects context within budget', () => {
    const selector = new ContextSelector({ maxChars: 100 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'observation' as const, content: 'old', timestampMs: 1, relevance: 1 },
      { id: 'e2', taskId: 't', kind: 'decision' as const, content: 'new decision', timestampMs: 100, relevance: 1 },
    ]
    const context = selector.select(entries, 'query')
    expect(context.length).toBeLessThanOrEqual(100)
    expect(context).toContain('new decision')
  })

  it('prefers recent decisions', () => {
    const selector = new ContextSelector({ maxChars: 50 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'note' as const, content: 'old note', timestampMs: 1, relevance: 1 },
      { id: 'e2', taskId: 't', kind: 'decision' as const, content: 'recent', timestampMs: 1000, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    // Recent decision should come first.
    expect(context.indexOf('recent')).toBeLessThan(context.indexOf('old note') === -1 ? Infinity : context.indexOf('old note'))
  })

  it('handles empty entries', () => {
    const selector = new ContextSelector()
    expect(selector.select([], 'q')).toBe('')
  })

  it('rejects invalid maxChars', () => {
    expect(() => new ContextSelector({ maxChars: 0 })).toThrow(/positive/)
  })

  it('truncates the next entry to the remaining budget, then stops', () => {
    const selector = new ContextSelector({ maxChars: 20 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'decision' as const, content: 'first', timestampMs: 100, relevance: 1 },
      { id: 'e2', taskId: 't', kind: 'note' as const, content: 'second long entry', timestampMs: 50, relevance: 1 },
      { id: 'e3', taskId: 't', kind: 'note' as const, content: 'third', timestampMs: 1, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    // First entry (highest score) is included whole; the second is truncated
    // to the 4 remaining characters with a marker, and selection stops.
    expect(context).toContain('first')
    expect(context).not.toContain('second')
    expect(context.length).toBeLessThanOrEqual(20)
    expect(context).toBe('[decision] first...[')
  })

  it('stops when the budget is exactly exhausted', () => {
    const selector = new ContextSelector({ maxChars: '[decision] first'.length })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'decision' as const, content: 'first', timestampMs: 100, relevance: 1 },
      { id: 'e2', taskId: 't', kind: 'note' as const, content: 'second', timestampMs: 50, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    expect(context).toBe('[decision] first')
  })

  it('truncates a single oversized entry to the budget with a marker', () => {
    const selector = new ContextSelector({ maxChars: 5 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'note' as const, content: 'very long content', timestampMs: 1, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    // The entry is shortened rather than dropped; the marker stays visible.
    expect(context.length).toBeLessThanOrEqual(5)
    expect(context).toBe('...[T')
  })

  it('uses default config', () => {
    const selector = new ContextSelector()
    const entries = [
      { id: 'e1', taskId: 't', kind: 'note' as const, content: 'x', timestampMs: 1, relevance: 1 },
    ]
    expect(selector.select(entries, 'q')).toContain('x')
  })
})

describe('WorkingMemory character budget (F13)', () => {
  it('R30: enforces the per-task bound on retrieve', () => {
    const memory = new WorkingMemory({ maxCharsPerTask: 8, newEntryId: () => 'e' })
    memory.store('t', 'note', 'x'.repeat(100), 1)
    const entries = memory.retrieve('t')
    expect(entries).toHaveLength(1)
    expect(entries.reduce((n, e) => n + e.content.length, 0)).toBeLessThanOrEqual(8)
  })

  it('truncates a single oversized entry with a marker', () => {
    const memory = new WorkingMemory({ maxCharsPerTask: 50, newEntryId: () => 'e' })
    const entry = memory.store('t', 'note', 'x'.repeat(100), 1)
    expect(entry.content).toHaveLength(50)
    expect(entry.content).toBe(`${'x'.repeat(36)}...[TRUNCATED]`)
  })

  it('keeps an entry that exactly fills the budget untouched', () => {
    const memory = new WorkingMemory({ maxCharsPerTask: 10, newEntryId: () => 'e' })
    const entry = memory.store('t', 'note', '1234567890', 1)
    expect(entry.content).toBe('1234567890')
  })

  it('evicts oldest entries before truncating the newest', () => {
    let id = 0
    const memory = new WorkingMemory({ maxCharsPerTask: 20, newEntryId: () => `e${++id}` })
    memory.store('t', 'note', '12345', 1)
    memory.store('t', 'note', 'x'.repeat(100), 2)
    const entries = memory.retrieve('t')
    // The old entry was evicted; the oversized newest entry was truncated.
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toHaveLength(20)
    expect(entries[0].content).toContain('[TRUNCATED]')
  })

  it('measures multibyte content in characters', () => {
    const memory = new WorkingMemory({ maxCharsPerTask: 50, newEntryId: () => 'e' })
    const entry = memory.store('t', 'note', '😀'.repeat(100), 1)
    expect(Array.from(entry.content)).toHaveLength(50)
    expect(entry.content.endsWith('...[TRUNCATED]')).toBe(true)
    expect(entry.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('cuts the marker itself for tiny budgets', () => {
    const memory = new WorkingMemory({ maxCharsPerTask: 1, newEntryId: () => 'e' })
    expect(memory.store('t', 'note', 'hello', 1).content).toBe('.')
  })
})

describe('ContextSelector character budget (F13)', () => {
  const entry = (id: string, kind: 'observation' | 'decision' | 'note', content: string, timestampMs: number) => ({
    id, taskId: 't', kind, content, timestampMs, relevance: 1,
  })

  it('R29: keeps a single large entry within its budget', () => {
    const selector = new ContextSelector({ maxChars: 8 })
    const context = selector.select(
      [entry('e', 'note', 'x'.repeat(100), 1)],
      'x',
    )
    expect(context.length).toBeLessThanOrEqual(8)
  })

  it('truncates an oversized entry to fit, keeping the label', () => {
    const selector = new ContextSelector({ maxChars: 100 })
    const context = selector.select([entry('e', 'note', 'x'.repeat(200), 1)], 'q')
    expect(context.length).toBeLessThanOrEqual(100)
    expect(context.startsWith('[note] ')).toBe(true)
    expect(context).toContain('[TRUNCATED]')
  })

  it('keeps entries that exactly fill the budget without a marker', () => {
    const selector = new ContextSelector({ maxChars: '[note] abc'.length })
    const context = selector.select([entry('e', 'note', 'abc', 1)], 'q')
    expect(context).toBe('[note] abc')
  })

  it('measures multibyte content in characters', () => {
    const fits = new ContextSelector({ maxChars: 40 })
    const whole = fits.select([entry('e', 'note', '😀'.repeat(30), 1)], 'q')
    // '[note] ' (7) + 30 emoji = 37 characters: fits whole.
    expect(Array.from(whole)).toHaveLength(37)

    const tight = new ContextSelector({ maxChars: 20 })
    const cut = tight.select([entry('e', 'note', '😀'.repeat(30), 1)], 'q')
    expect(Array.from(cut)).toHaveLength(20)
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('cuts the marker itself for a tiny budget', () => {
    const selector = new ContextSelector({ maxChars: 1 })
    expect(selector.select([entry('e', 'note', 'hello', 1)], 'q')).toBe('.')
  })
})
