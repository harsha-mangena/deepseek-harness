/**
 * Unit tests for the orchestrator module: delegation triage question
 * building, advisory copy, duplicate-purpose detection, and the bounded
 * spawn registry. No network, no composition — pure functions and state.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildDelegationAdvisory,
  buildDelegationTriageQuestion,
  buildDuplicateWarning,
  createDelegationState,
  DUPLICATE_SIMILARITY,
  extractSpawnArgs,
  MAX_SPAWNS,
  SPAWN_TOOL_NAME,
} from '../src/orchestrator.ts'

describe('extractSpawnArgs', () => {
  it('extracts name, description, and prompt from valid arguments', () => {
    expect(extractSpawnArgs({ name: 'reviewer', description: 'reviews code', prompt: 'do it', context: 'fresh' }))
      .toEqual({ name: 'reviewer', description: 'reviews code', prompt: 'do it' })
  })

  it('returns null for malformed arguments instead of throwing', () => {
    expect(extractSpawnArgs(null)).toBeNull()
    expect(extractSpawnArgs('spawn')).toBeNull()
    expect(extractSpawnArgs({})).toBeNull()
    expect(extractSpawnArgs({ name: 'x', description: 'y' })).toBeNull() // missing prompt
    expect(extractSpawnArgs({ name: '', description: 'y', prompt: 'z' })).toBeNull()
    expect(extractSpawnArgs({ name: 42, description: 'y', prompt: 'z' })).toBeNull()
  })
})

describe('buildDelegationTriageQuestion', () => {
  it('builds a choice question reusing the triage verdict vocabulary', () => {
    const question = buildDelegationTriageQuestion(
      'reviewer',
      'Review the pull request for bugs and style issues.',
      'You are the reviewer. Read the diff and report findings.',
    )
    expect(question.kind).toBe('delegation-triage')
    expect(question.primitive).toBe('choice')
    expect(Object.keys(question.options ?? {})).toEqual(['trivial', 'standard', 'complex'])
    expect(question.context['delegation']).toMatchObject({ name: 'reviewer' })
  })

  it('never throws on hostile input', () => {
    expect(() => buildDelegationTriageQuestion('', '', '')).not.toThrow()
  })
})

describe('buildDelegationAdvisory', () => {
  it('stays silent on trivial delegations', () => {
    expect(buildDelegationAdvisory('helper', 'trivial')).toBeNull()
  })

  it('names the chain-of-thoughts strategy for standard subtasks', () => {
    const advisory = buildDelegationAdvisory('researcher', 'standard')
    expect(advisory).toContain('[System 1 delegation triage: standard]')
    expect(advisory).toContain('"researcher"')
    expect(advisory).toContain('chain-of-thoughts')
  })

  it('names the tree-of-thoughts strategy and oversight for complex subtasks', () => {
    const advisory = buildDelegationAdvisory('architect', 'complex')
    expect(advisory).toContain('[System 1 delegation triage: complex]')
    expect(advisory).toContain('"architect"')
    expect(advisory).toContain('tree-of-thoughts')
    expect(advisory).toContain('2–3 candidate approaches')
  })
})

describe('buildDuplicateWarning', () => {
  it('names both teammates and the earlier purpose', () => {
    const warning = buildDuplicateWarning('code-reviewer', {
      name: 'reviewer',
      description: 'Review pull requests for bugs',
      at: Date.now() - 5 * 60000,
    })
    expect(warning).toContain('[System 1 delegation]')
    expect(warning).toContain('"code-reviewer"')
    expect(warning).toContain('"reviewer"')
    expect(warning).toContain('Review pull requests for bugs')
  })
})

describe('createDelegationState', () => {
  it('flags an identical normalized name as a duplicate', () => {
    const state = createDelegationState()
    state.noteSpawn('Reviewer', 'Looks at diffs')
    const duplicate = state.findDuplicate('reviewer', 'Something entirely different')
    expect(duplicate?.name).toBe('Reviewer')
  })

  it('flags a similar purpose as a duplicate', () => {
    const state = createDelegationState()
    state.noteSpawn('code-reviewer', 'Review pull request code for bugs and style')
    const duplicate = state.findDuplicate(
      'pr-reviewer',
      'Review pull request code for bugs and issues',
    )
    expect(duplicate?.name).toBe('code-reviewer')
  })

  it('does not flag distinct purposes', () => {
    const state = createDelegationState()
    state.noteSpawn('code-reviewer', 'Review pull request code for bugs and style')
    expect(state.findDuplicate(
      'db-migrator',
      'Write postgres migration scripts for the billing service',
    )).toBeNull()
  })

  it('does not match the candidate against itself when checked before recording', () => {
    const state = createDelegationState()
    // Correct call order: check first, record after.
    expect(state.findDuplicate('reviewer', 'Review pull requests')).toBeNull()
    state.noteSpawn('reviewer', 'Review pull requests')
    expect(state.findDuplicate('reviewer', 'Review pull requests')?.name).toBe('reviewer')
  })

  it('ignores spawns older than the window', () => {
    vi.useFakeTimers()
    try {
      const state = createDelegationState(MAX_SPAWNS, 60 * 1000)
      state.noteSpawn('reviewer', 'Review pull request code for bugs and style')
      vi.advanceTimersByTime(61 * 1000)
      expect(state.findDuplicate('pr-reviewer', 'Review pull request code for bugs and issues')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the registry at maxSpawns', () => {
    const state = createDelegationState(3)
    const purposes = [
      'Review pull request code for bugs and style',
      'Write postgres migration scripts for billing',
      'Summarize the payments API documentation',
      'Design the new checkout flow end to end',
      'Triage incoming support tickets by severity',
      'Refactor the auth middleware for clarity',
      'Load test the search cluster at peak traffic',
      'Draft release notes for version two',
      'Audit third-party dependencies for licenses',
      'Prototype the onboarding email sequence',
    ]
    purposes.forEach((purpose, index) => { state.noteSpawn(`agent-${index}`, purpose) })
    expect(state.size()).toBe(3)
    // The survivors are the most recent spawns.
    expect(state.findDuplicate('agent-9', 'Prototype the onboarding email sequence')?.name).toBe('agent-9')
    expect(state.findDuplicate('agent-0', 'Review pull request code for bugs and style')).toBeNull()
  })

  it('returns null for empty purposes', () => {
    const state = createDelegationState()
    state.noteSpawn('reviewer', 'Review pull requests')
    expect(state.findDuplicate('', '')).toBeNull()
  })

  it('exposes the spawn tool name constant', () => {
    expect(SPAWN_TOOL_NAME).toBe('spawn_teammate')
    expect(DUPLICATE_SIMILARITY).toBeGreaterThan(0)
  })
})
