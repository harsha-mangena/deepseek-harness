/**
 * Unit tests for {@link createAgentState}: the bounded per-agent tracking
 * state behind loop detection. Noting a new agent past the budget evicts
 * the oldest agent's history and turn marker (F6).
 */

import { describe, expect, it } from 'vitest'
import { MAX_TRACKED_AGENTS, createAgentState } from '../src/index.ts'

describe('createAgentState', () => {
  it('returns the same history array for a known agent', () => {
    const agents = createAgentState(2)
    const first = agents.note('a1')
    first.push({ name: 'read', argsKey: '{}', isError: false, at: 1 })
    expect(agents.note('a1')).toBe(first)
    expect(agents.histories.get('a1')).toHaveLength(1)
  })

  it('evicts the oldest agent past the budget, including its turn marker', () => {
    const agents = createAgentState(2)
    agents.note('a1')
    agents.turns.set('a1', 7)
    agents.note('a2')
    agents.note('a3')
    expect(agents.histories.has('a1')).toBe(false)
    expect(agents.turns.has('a1')).toBe(false)
    expect(agents.histories.has('a2')).toBe(true)
    expect(agents.histories.has('a3')).toBe(true)
    expect(agents.histories.size).toBe(2)
  })

  it('defaults to MAX_TRACKED_AGENTS', () => {
    const agents = createAgentState()
    for (let i = 0; i < MAX_TRACKED_AGENTS + 1; i += 1) agents.note(`agent-${i}`)
    expect(agents.histories.size).toBe(MAX_TRACKED_AGENTS)
    expect(agents.histories.has('agent-0')).toBe(false)
    expect(agents.histories.has(`agent-${MAX_TRACKED_AGENTS}`)).toBe(true)
  })
})
