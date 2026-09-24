/**
 * Unit tests for the orchestrator module: the delegation composite
 * (novelty/tool-risk/irreversibility scores → oversight judgment), advisory
 * copy, duplicate-purpose detection, and the bounded spawn registry. No
 * network, no composition — pure functions and state.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildDelegationAdvisory,
  buildDelegationTriageQuestions,
  buildDuplicateWarning,
  computeDelegationOversight,
  createDelegationState,
  DEFAULT_DELEGATION_WEIGHTS,
  DUPLICATE_SIMILARITY,
  extractSpawnArgs,
  MAX_SPAWNS,
  SPAWN_TOOL_NAME,
  validateDelegationTriage,
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

describe('buildDelegationTriageQuestions', () => {
  it('builds three atomic score questions', () => {
    const questions = buildDelegationTriageQuestions(
      'reviewer',
      'Review the pull request for bugs and style issues.',
      'You are the reviewer. Read the diff and report findings.',
    )
    expect(questions).toHaveLength(3)
    for (const question of questions) {
      expect(question.kind).toBe('delegation-triage')
      expect(question.primitive).toBe('score')
      expect(question.levels).toHaveLength(4)
    }
    expect(questions[0]?.context['delegation']).toMatchObject({ name: 'reviewer' })
  })

  it('never throws on hostile input', () => {
    expect(() => buildDelegationTriageQuestions('', '', '')).not.toThrow()
  })

  it('re-exports the score validator', () => {
    expect(validateDelegationTriage(2)).toBe(2)
    expect(validateDelegationTriage(5)).toBeNull()
  })
})

describe('computeDelegationOversight', () => {
  it('tiers a low composite as low oversight', () => {
    const oversight = computeDelegationOversight({ novelty: 0.3, toolRisk: 0.2, irreversibility: 0.4 })
    expect(oversight.level).toBe('low')
    expect(oversight.score).toBeLessThan(0.35)
  })

  it('tiers a moderate composite as standard oversight', () => {
    const oversight = computeDelegationOversight({ novelty: 1.6, toolRisk: 1.5, irreversibility: 1.4 })
    expect(oversight.level).toBe('standard')
    expect(oversight.score).toBeGreaterThanOrEqual(0.35)
    expect(oversight.score).toBeLessThan(0.65)
  })

  it('tiers a demanding composite as high oversight', () => {
    const oversight = computeDelegationOversight({ novelty: 2.8, toolRisk: 2.6, irreversibility: 2.9 })
    expect(oversight.level).toBe('high')
    expect(oversight.score).toBeGreaterThanOrEqual(0.65)
  })

  it('normalizes weights that do not sum to 1', () => {
    const doubled = {
      novelty: DEFAULT_DELEGATION_WEIGHTS.novelty * 2,
      toolRisk: DEFAULT_DELEGATION_WEIGHTS.toolRisk * 2,
      irreversibility: DEFAULT_DELEGATION_WEIGHTS.irreversibility * 2,
    }
    const scores = { novelty: 2, toolRisk: 1, irreversibility: 3 }
    expect(computeDelegationOversight(scores, doubled).score)
      .toBeCloseTo(computeDelegationOversight(scores).score, 10)
  })

  it('weights novelty highest by default', () => {
    // Novelty alone at max pushes the composite above the standard line;
    // irreversibility alone at max does not reach high.
    const noveltyDriven = computeDelegationOversight({ novelty: 3, toolRisk: 0, irreversibility: 0 })
    const irreversibleDriven = computeDelegationOversight({ novelty: 0, toolRisk: 0, irreversibility: 3 })
    expect(noveltyDriven.score).toBeGreaterThan(irreversibleDriven.score)
  })

  it('rejects non-positive total weight', () => {
    expect(() => computeDelegationOversight(
      { novelty: 1, toolRisk: 1, irreversibility: 1 },
      { novelty: 0, toolRisk: 0, irreversibility: 0 },
    )).toThrow()
  })
})

describe('buildDelegationAdvisory', () => {
  const low = computeDelegationOversight({ novelty: 0.3, toolRisk: 0.2, irreversibility: 0.4 })
  const standard = computeDelegationOversight({ novelty: 1.6, toolRisk: 1.5, irreversibility: 1.4 })
  const high = computeDelegationOversight({ novelty: 2.8, toolRisk: 2.6, irreversibility: 2.9 })

  it('stays silent on low oversight', () => {
    expect(buildDelegationAdvisory('helper', low)).toBeNull()
  })

  it('names the grounded chain strategy for standard oversight', () => {
    const advisory = buildDelegationAdvisory('researcher', standard)
    expect(advisory).toContain('[System 1 delegation: standard oversight]')
    expect(advisory).toContain('"researcher"')
    expect(advisory).toContain('chain-of-thought')
  })

  it('names atomic decomposition and oversight for high oversight', () => {
    const advisory = buildDelegationAdvisory('architect', high)
    expect(advisory).toContain('[System 1 delegation: high oversight]')
    expect(advisory).toContain('"architect"')
    expect(advisory).toContain('atomic-decomposition')
    expect(advisory).toContain('check its early output')
  })

  it('restates the driving scores so the Lead sees the why', () => {
    const advisory = buildDelegationAdvisory('architect', high)
    expect(advisory).toContain('novelty 2.8/3')
    expect(advisory).toContain('tool risk 2.6/3')
    expect(advisory).toContain('irreversibility 2.9/3')
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
