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
    expect(entries.map((e) => e.content)).toEqual(['67890', 'abc'])
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

  it('breaks when budget exceeded', () => {
    const selector = new ContextSelector({ maxChars: 20 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'decision' as const, content: 'first', timestampMs: 100, relevance: 1 },
      { id: 'e2', taskId: 't', kind: 'note' as const, content: 'second long entry', timestampMs: 50, relevance: 1 },
      { id: 'e3', taskId: 't', kind: 'note' as const, content: 'third', timestampMs: 1, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    // First entry (highest score) is included; second would exceed budget.
    expect(context).toContain('first')
    expect(context).not.toContain('second')
  })

  it('includes first entry even if over budget', () => {
    const selector = new ContextSelector({ maxChars: 5 })
    const entries = [
      { id: 'e1', taskId: 't', kind: 'note' as const, content: 'very long content', timestampMs: 1, relevance: 1 },
    ]
    const context = selector.select(entries, 'q')
    // First entry is always included (better than empty context).
    expect(context).toContain('very long content')
  })

  it('uses default config', () => {
    const selector = new ContextSelector()
    const entries = [
      { id: 'e1', taskId: 't', kind: 'note' as const, content: 'x', timestampMs: 1, relevance: 1 },
    ]
    expect(selector.select(entries, 'q')).toContain('x')
  })
})
