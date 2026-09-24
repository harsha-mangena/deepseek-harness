/** Supplemental coverage: deterministic utilities and provider edge cases. */

import { describe, expect, it } from 'vitest'
import {
  ManualClock,
  RandomIdGenerator,
  RecordedDecisionProvider,
  SequentialIdGenerator,
} from '@deepseek-ai/dsh-system1-coordination'

describe('deterministic utilities', () => {
  it('rejects backwards clock advances', () => {
    const clock = new ManualClock(1000)
    expect(() => clock.advance(-1)).toThrow(/backwards/)
    clock.set(2000)
    expect(clock.now()).toBe(2000)
  })

  it('generates random and sequential IDs', () => {
    const random = new RandomIdGenerator()
    const a = random.next('task')
    const b = random.next('task')
    expect(a).not.toBe(b)
    expect(a.startsWith('task-')).toBe(true)

    const seq = new SequentialIdGenerator()
    expect(seq.next()).toBe('id-000001')
    expect(seq.next('task')).toBe('task-000002')
    seq.reset()
    expect(seq.next()).toBe('id-000001')
  })
})

describe('recorded provider edge cases', () => {
  const input = {
    schemaVersion: 1 as const,
    taskId: 't1',
    decisionId: 'd1',
    stateVersion: 0,
    policyVersion: 'p1',
    catalogVersion: 'c1',
    observationHash: 'o1',
    questionFamily: 'q1',
    promptVersion: 'p1',
    state: 's',
    candidates: [
      {
        id: 'c1',
        label: 'l',
        route: 'tool' as const,
        effect: 'read' as const,
        operationRef: 'op',
        preconditionHash: 'h',
        verificationPolicyId: 'v',
      },
    ],
  }

  const decision = {
    decisionId: 'd1',
      questionFamily: 'select-candidate',
      promptVersion: 'p1',
    selectedId: 'c1',
    probabilities: { c1: 1 },
    selectedProbability: 1,
    vendorConfidence: null,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: 'jev-1',
    modelResolved: null,
    requestId: null,
    usage: { inputTokens: 10, outputTokens: null },
    reasonCode: 'accepted' as const,
  }

  it('injects timeout and malformed-response faults', async () => {
    const provider = new RecordedDecisionProvider()
    provider.injectFault('d1', { kind: 'timeout' })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/timeout/)

    provider.injectFault('d1', { kind: 'malformed-response' })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/malformed/)
  })

  it('rejects recordings with mismatched decision IDs', async () => {
    const provider = new RecordedDecisionProvider()
    provider.record('d1', { ...decision, decisionId: 'd2' })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/mismatch/)
  })

  it('rejects invalid decision input at the trust boundary', async () => {
    const provider = new RecordedDecisionProvider()
    provider.record('d1', decision)
    const badInput = { ...input, candidates: [] }
    await expect(provider.decide(badInput, new AbortController().signal)).rejects.toThrow(
      /failed validation/,
    )
  })
})
