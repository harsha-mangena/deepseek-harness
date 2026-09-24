/** Contract schema validation, reducer, and migration tests. */

import { describe, expect, it } from 'vitest'
import {
  CandidateSchema,
  DecisionInputSchema,
  ExecutionOutcomeSchema,
  NormalizedDecisionSchema,
  VerificationResultSchema,
  initialWorkflowState,
  isTerminalState,
  migrateToCurrent,
  reduceTransition,
  system1Error,
} from '@deepseek-ai/dsh-system1-contracts'

const candidate = {
  id: 'c1',
  label: 'Read CI runs',
  route: 'tool',
  effect: 'read',
  operationRef: 'op:ci-runs:read:v1',
  preconditionHash: 'abc123',
  verificationPolicyId: 'verify:ci-runs:v1',
}

describe('contract schemas', () => {
  it('accepts a valid decision input and rejects unknown fields', () => {
    const input = {
      schemaVersion: 1,
      taskId: 't1',
      decisionId: 'd1',
      stateVersion: 3,
      policyVersion: 'p1',
      catalogVersion: 'cat9',
      observationHash: 'obs1',
      questionFamily: 'read-only-bundle',
      promptVersion: 'prompt2',
      state: 'bounded state',
      candidates: [candidate],
    }
    expect(DecisionInputSchema.safeParse(input).success).toBe(true)
    const withExtra = { ...input, extraField: 'nope' }
    const result = DecisionInputSchema.safeParse(withExtra)
    expect(result.success).toBe(false)
  })

  it('rejects candidates outside the provider limits', () => {
    const base = {
      schemaVersion: 1,
      taskId: 't1',
      decisionId: 'd1',
      stateVersion: 0,
      policyVersion: 'p1',
      catalogVersion: 'c1',
      observationHash: 'o1',
      questionFamily: 'q1',
      promptVersion: 'p1',
      state: 's',
      candidates: [],
    }
    // Empty menu rejected.
    expect(DecisionInputSchema.safeParse(base).success).toBe(false)
    // Over-large menu rejected.
    const many = Array.from({ length: 33 }, (_, i) => ({ ...candidate, id: `c${i}` }))
    expect(DecisionInputSchema.safeParse({ ...base, candidates: many }).success).toBe(false)
  })

  it('validates normalized decisions with distinct confidence fields', () => {
    const decision = {
      decisionId: 'd1',
      selectedId: 'c1',
      probabilities: { c1: 0.9, c2: 0.1 },
      selectedProbability: 0.9,
      vendorConfidence: 0.85,
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested: 'jev-1',
      modelResolved: 'jev-1-rev3',
      requestId: 'req-1',
      usage: { inputTokens: 120, outputTokens: null },
      reasonCode: 'accepted',
    }
    const parsed = NormalizedDecisionSchema.safeParse(decision)
    expect(parsed.success).toBe(true)
    // NaN probability rejected.
    const bad = { ...decision, probabilities: { c1: Number.NaN } }
    expect(NormalizedDecisionSchema.safeParse(bad).success).toBe(false)
  })

  it('discriminates execution outcomes including unknown', () => {
    expect(
      ExecutionOutcomeSchema.safeParse({ kind: 'succeeded', receiptRef: 'r1', evidenceRefs: ['e1'] }).success,
    ).toBe(true)
    expect(
      ExecutionOutcomeSchema.safeParse({ kind: 'failed', errorCode: 'E1', retryClass: 'backoff' }).success,
    ).toBe(true)
    expect(
      ExecutionOutcomeSchema.safeParse({ kind: 'unknown', reconciliationRef: 'rec1' }).success,
    ).toBe(true)
    expect(ExecutionOutcomeSchema.safeParse({ kind: 'mystery' }).success).toBe(false)
  })

  it('validates verification results', () => {
    const result = {
      status: 'pass',
      verifierId: 'v-ci-runs',
      verifierVersion: '1',
      evidenceRefs: ['e1'],
      observedResourceVersions: { 'repo:main': 'sha123' },
      failures: [],
    }
    expect(VerificationResultSchema.safeParse(result).success).toBe(true)
    expect(CandidateSchema.safeParse({ ...candidate, effect: 'delete' }).success).toBe(false)
  })
})

describe('workflow reducer', () => {
  it('applies legal transitions and increments the version', () => {
    const s0 = initialWorkflowState('t1', 7)
    expect(s0.state).toBe('admitted')
    const s1 = reduceTransition(s0, { taskId: 't1', to: 'observing', expectedVersion: 0, expectedFencingToken: 7 })
    expect(s1.state).toBe('observing')
    expect(s1.version).toBe(1)
    expect(s1.fencingToken).toBe(7)
  })

  it('rejects illegal transitions', () => {
    const s0 = initialWorkflowState('t1', 7)
    expect(() =>
      reduceTransition(s0, { taskId: 't1', to: 'succeeded', expectedVersion: 0, expectedFencingToken: 7 }),
    ).toThrow(/Illegal transition admitted -> succeeded/)
  })

  it('rejects stale versions and fencing tokens', () => {
    const s0 = initialWorkflowState('t1', 7)
    const s1 = reduceTransition(s0, { taskId: 't1', to: 'observing', expectedVersion: 0, expectedFencingToken: 7 })
    expect(() =>
      reduceTransition(s1, { taskId: 't1', to: 'deciding', expectedVersion: 0, expectedFencingToken: 7 }),
    ).toThrow(/Stale workflow version/)
    expect(() =>
      reduceTransition(s1, { taskId: 't1', to: 'deciding', expectedVersion: 1, expectedFencingToken: 8 }),
    ).toThrow(/Stale fencing token/)
  })

  it('replays a full terminal path deterministically', () => {
    const path = ['observing', 'deciding', 'executing', 'verifying', 'succeeded'] as const
    let state = initialWorkflowState('t-replay', 1)
    for (const to of path) {
      state = reduceTransition(state, {
        taskId: 't-replay',
        to,
        expectedVersion: state.version,
        expectedFencingToken: 1,
      })
    }
    expect(state.state).toBe('succeeded')
    expect(state.version).toBe(5)
    expect(isTerminalState(state.state)).toBe(true)
    expect(isTerminalState('executing')).toBe(false)
    // Terminal states have no outgoing edges.
    expect(() =>
      reduceTransition(state, { taskId: 't-replay', to: 'observing', expectedVersion: 5, expectedFencingToken: 1 }),
    ).toThrow(/Illegal transition/)
  })
})

describe('migrations', () => {
  it('passes current records through and rejects corrupt ones', () => {
    const record = { schemaVersion: 1, data: 'x' }
    expect(migrateToCurrent(record)).toEqual(record)
    expect(() => migrateToCurrent({ schemaVersion: 0 })).toThrow(/no valid schemaVersion/)
    expect(() => migrateToCurrent({ schemaVersion: 99 })).toThrow(/newer than supported/)
  })

  it('creates errors with default retry classes', () => {
    const err = system1Error('BUDGET_EXHAUSTED', 'no budget left')
    expect(err.code).toBe('BUDGET_EXHAUSTED')
    expect(err.retryClass).toBe('escalate')
    expect(err.isContractViolation).toBe(false)
    const contract = system1Error('ILLEGAL_STATE_TRANSITION', 'bad transition')
    expect(contract.isContractViolation).toBe(true)
  })
})
