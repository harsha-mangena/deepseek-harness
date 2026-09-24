/** Delegation tests. */

import { describe, expect, it } from 'vitest'
import { DelegationManager, MAX_DELEGATION_DEPTH } from '@deepseek-ai/dsh-system1-delegation'
import type { DelegationRequest } from '@deepseek-ai/dsh-system1-delegation'

function testRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    parentTaskId: 'parent-1',
    parentDecisionId: 'dec-1',
    depth: 0,
    task: 'Generate a report',
    context: 'Q3 results',
    budgetUnits: 10,
    ...overrides,
  }
}

describe('DelegationManager', () => {
  it('creates delegated tasks with incremented depth', () => {
    const manager = new DelegationManager({ newTaskId: () => 'child-1' })
    const task = manager.delegate(testRequest())
    expect(task.taskId).toBe('child-1')
    expect(task.parentTaskId).toBe('parent-1')
    expect(task.depth).toBe(1)
    expect(task.budgetUnits).toBe(10)
  })

  it('enforces maximum depth', () => {
    const manager = new DelegationManager({ newTaskId: () => 'child' })
    expect(() =>
      manager.delegate(testRequest({ depth: MAX_DELEGATION_DEPTH })),
    ).toThrow(/depth limit exceeded/)
    expect(() =>
      manager.delegate(testRequest({ depth: MAX_DELEGATION_DEPTH - 1 })),
    ).not.toThrow()
  })

  it('respects custom max depth', () => {
    const manager = new DelegationManager({ newTaskId: () => 'c', maxDepth: 2 })
    expect(manager.canDelegate(0)).toBe(true)
    expect(manager.canDelegate(1)).toBe(true)
    expect(manager.canDelegate(2)).toBe(false)
    expect(() => manager.delegate(testRequest({ depth: 2 }))).toThrow(/depth limit/)
  })

  it('rejects invalid max depth', () => {
    expect(() => new DelegationManager({ newTaskId: () => 'c', maxDepth: 0 })).toThrow(
      /at least 1/,
    )
  })

  it('requires positive budget', () => {
    const manager = new DelegationManager({ newTaskId: () => 'c' })
    expect(() => manager.delegate(testRequest({ budgetUnits: 0 }))).toThrow(/positive budget/)
    expect(() => manager.delegate(testRequest({ budgetUnits: -5 }))).toThrow(/positive budget/)
  })

  it('reports delegation capability', () => {
    const manager = new DelegationManager({ newTaskId: () => 'c' })
    expect(manager.canDelegate(0)).toBe(true)
    expect(manager.canDelegate(MAX_DELEGATION_DEPTH - 1)).toBe(true)
    expect(manager.canDelegate(MAX_DELEGATION_DEPTH)).toBe(false)
  })
})
