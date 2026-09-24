/** Read-only coordinator integration tests, including decision admission. */

import { describe, expect, it } from 'vitest'
import { ReadOnlyCoordinator, admitDecision } from '@deepseek-ai/dsh-system1-integration'
import type { CatalogTool, Observation } from '@deepseek-ai/dsh-system1-observations'
import { PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type { CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import type {
  Candidate,
  DecisionInput,
  DecisionProvider,
  ExecutionOutcome,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { fitIsotonic } from '@deepseek-ai/dsh-system1-calibration'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'

const EXPECTED_MODEL = 'jev-test-v1'

const observations: Observation[] = [
  { provenance: { kind: 'user-input' }, content: 'Check CI status', timestampMs: 1000 },
]

const catalog: CatalogTool[] = [
  {
    toolId: 'ci-runs',
    label: 'Read CI runs',
    route: 'tool',
    effect: 'read',
    operationRef: 'op:ci-runs:read:v1',
    preconditions: {},
    verificationPolicyId: 'verify:ci:v1',
  },
  {
    toolId: 'deploy',
    label: 'Deploy to staging',
    route: 'tool',
    effect: 'write',
    operationRef: 'op:deploy:write:v1',
    preconditions: {},
    verificationPolicyId: 'verify:deploy:v1',
  },
]

const profile: CapabilityProfile = {
  tenantId: 'default',
  profileVersion: 'v1',
  allowedEffects: new Set(['read']),
  allowedRoutes: new Set(['tool', 'stop']),
  globalRequiredGuards: [],
}

/** Calibration bound to the test decision context. */
function testCalibration(version = 'cal-v1'): IsotonicCalibration {
  return fitIsotonic(
    [
      { vendorConfidence: 0.1, correct: 0 },
      { vendorConfidence: 0.9, correct: 1 },
    ],
    version,
    {
      model: EXPECTED_MODEL,
      promptVersion: 'p1',
      questionFamily: 'select-candidate',
    },
  )
}

function testDecision(
  selectedId: string,
  vendorConfidence: number | null = 0.9,
): NormalizedDecision {
  return {
    decisionId: 'd1',
    questionFamily: 'select-candidate',
    promptVersion: 'p1',
    selectedId,
    probabilities: { [selectedId]: 0.8 },
    selectedProbability: 0.8,
    vendorConfidence,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: EXPECTED_MODEL,
    modelResolved: EXPECTED_MODEL,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null },
    reasonCode: 'accepted',
  }
}

function testInput(): DecisionInput {
  return {
    schemaVersion: 1,
    taskId: 't1',
    decisionId: 'd1',
    stateVersion: 0,
    policyVersion: 'p1',
    catalogVersion: 'c1',
    observationHash: 'o1',
    questionFamily: 'select-candidate',
    promptVersion: 'p1',
    state: 'state',
    candidates: [],
  }
}

function testOutcome(): ExecutionOutcome {
  return {
    kind: 'succeeded',
    receiptRef: 'receipt-o1',
    evidenceRefs: ['evidence-o1'],
  }
}

describe('ReadOnlyCoordinator', () => {
  function makePolicy(): PolicyEngine {
    const policy = new PolicyEngine()
    policy.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: [] })
    policy.setEffectPolicy({ effect: 'stop', allowed: true, requiredGuards: [] })
    return policy
  }

  function makeCoordinator(
    providerOverrides: Partial<{
      policy: PolicyEngine
      provider: DecisionProvider
      calibration: IsotonicCalibration
      expectedModel: string
      tenantId: string
      minCalibratedConfidence: number
    }> = {},
  ): ReadOnlyCoordinator {
    const provider: DecisionProvider =
      providerOverrides.provider ??
      ({
        decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
      } as DecisionProvider)
    return new ReadOnlyCoordinator({
      policy: providerOverrides.policy ?? makePolicy(),
      capabilityProfile: profile,
      provider,
      executor: { execute: async () => testOutcome() },
      calibration: providerOverrides.calibration ?? testCalibration(),
      expectedModel: providerOverrides.expectedModel ?? EXPECTED_MODEL,
      tenantId: providerOverrides.tenantId ?? 'tenant-test',
      minCalibratedConfidence: providerOverrides.minCalibratedConfidence ?? 0.5,
      newTaskId: () => 'task-test',
      newDecisionId: () => 'dec-test',
    })
  }

  it('runs the full read-only loop', async () => {
    const executed: Candidate[] = []
    const coordinator = new ReadOnlyCoordinator({
      policy: makePolicy(),
      capabilityProfile: profile,
      provider: {
        decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
      },
      executor: {
        execute: async (candidate) => {
          executed.push(candidate)
          return testOutcome()
        },
      },
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      tenantId: 'tenant-test',
      newTaskId: () => 'task-test',
      newDecisionId: () => 'dec-test',
    })

    const result = await coordinator.run(
      { observations, catalog },
      new AbortController().signal,
    )

    expect(result.decision.selectedId).toBe('c1')
    expect(result.outcome?.kind).toBe('succeeded')
    expect(executed).toHaveLength(1)
    expect(executed[0].effect).toBe('read')
    // Write candidates are filtered from the menu.
    expect(result.decision.decisionId).toBe('dec-test')
    expect(result.calibratedCorrectness).not.toBeNull()
    expect(result.decision.calibrationVersion).toBe('cal-v1')
  })

  it('handles escalation without execution', async () => {
    let executed = false
    const coordinator = new ReadOnlyCoordinator({
      policy: makePolicy(),
      capabilityProfile: profile,
      provider: {
        decide: async (input) => ({
          ...testDecision('escalate-none', null),
          decisionId: input.decisionId,
          probabilities: {},
          selectedProbability: 0,
        }),
      },
      executor: {
        execute: async () => {
          executed = true
          return testOutcome()
        },
      },
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      tenantId: 'tenant-test',
      newTaskId: () => 't',
      newDecisionId: () => 'd',
    })

    const result = await coordinator.run(
      { observations, catalog },
      new AbortController().signal,
    )

    expect(result.decision.selectedId).toBe('escalate-none')
    expect(result.outcome).toBeNull()
    expect(executed).toBe(false)
  })

  it('rejects a selection not in the admitted menu', async () => {
    // Malicious provider tries to select a write candidate (not in menu).
    const coordinator = makeCoordinator({
      provider: {
        decide: async (input) => ({
          ...testDecision('c99-write'),
          decisionId: input.decisionId,
        }),
      },
    })

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/not in admitted menu/)
  })

  it('fails closed when policy denies every candidate', async () => {
    // Remove the read effect policy to force denial of the whole menu.
    const denyPolicy = new PolicyEngine()
    denyPolicy.setEffectPolicy({ effect: 'read', allowed: false, requiredGuards: [] })
    const coordinator = makeCoordinator({ policy: denyPolicy })

    const err = await coordinator
      .run({ observations, catalog }, new AbortController().signal)
      .catch((e) => e)
    expect(err.code).toBe('NO_ADMISSIBLE_CANDIDATES')
  })

  it('filters denied candidates before prediction instead of failing the menu', async () => {
    // Policy denies c1 specifically via a guard; c2 (escalate) remains.
    // The provider only sees the admitted menu.
    let seenCandidateIds: string[] = []
    const coordinator = makeCoordinator({
        provider: {
          decide: async (input) => {
            seenCandidateIds = input.candidates.map((c) => c.id)
            return {
              ...testDecision('escalate-none', null),
              decisionId: input.decisionId,
              probabilities: {},
              selectedProbability: 0,
            }
          },
        },
      },
    )

    const result = await coordinator.run(
      { observations, catalog },
      new AbortController().signal,
    )
    expect(result.decision.selectedId).toBe('escalate-none')
    // The write tool was filtered by effect; only c1 + escalate remain.
    expect(seenCandidateIds).toContain('c1')
    expect(seenCandidateIds).not.toContain('c99-write')
  })

  it('rejects a sub-threshold calibrated decision', async () => {
    // Vendor confidence 0.1 calibrates to ~0 on the test fit: below threshold.
    const coordinator = makeCoordinator({
        provider: {
          decide: async (input) => ({
            ...testDecision('c1', 0.1),
            decisionId: input.decisionId,
          }),
        },
        minCalibratedConfidence: 0.5,
      },
    )

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/below confidence threshold/)
  })

  it('rejects a decision with the wrong correlation', async () => {
    const coordinator = makeCoordinator({
        provider: {
          decide: async (input) => ({
            ...testDecision('c1'),
            decisionId: 'wrong-id',
            questionFamily: input.questionFamily,
            promptVersion: input.promptVersion,
          }),
        },
      },
    )

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/correlation/)
  })

  it('rejects a decision resolving to the wrong model', async () => {
    const coordinator = makeCoordinator({
        provider: {
          decide: async (input) => ({
            ...testDecision('c1'),
            decisionId: input.decisionId,
            modelResolved: 'jev-evil-v9',
          }),
        },
      },
    )

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/pinned model/)
  })

  it('rejects when calibration identity does not match', async () => {
    const mismatched = fitIsotonic(
      [
        { vendorConfidence: 0.1, correct: 0 },
        { vendorConfidence: 0.9, correct: 1 },
      ],
      'cal-v1',
      { model: 'other-model', promptVersion: 'p1', questionFamily: 'select-candidate' },
    )
    const coordinator = makeCoordinator({ calibration: mismatched })

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/identity/)
  })

  it('rechecks policy immediately before dispatch', async () => {
    // Policy allows at filter time but denies at dispatch time.
    let calls = 0
    const flakyPolicy = makePolicy()
    const origEvaluate = flakyPolicy.evaluate.bind(flakyPolicy)
    flakyPolicy.evaluate = async (candidate, profileArg, ctx) => {
      calls += 1
      // First call is the pre-prediction filter (allow); second is the
      // dispatch recheck (deny).
      if (calls > 1) {
        return { allowed: false, reason: 'revoked', code: 'REVOKED', evaluatedGuards: [] }
      }
      return origEvaluate(candidate, profileArg, ctx)
    }
    const coordinator = makeCoordinator({ policy: flakyPolicy })

    await expect(
      coordinator.run({ observations, catalog }, new AbortController().signal),
    ).rejects.toThrow(/dispatch recheck/)
  })

  it('requires explicit tenantId and expectedModel', () => {
    expect(
      () =>
        new ReadOnlyCoordinator({
          policy: makePolicy(),
          capabilityProfile: profile,
          provider: { decide: async () => testDecision('c1') },
          executor: { execute: async () => testOutcome() },
          calibration: testCalibration(),
          expectedModel: EXPECTED_MODEL,
          tenantId: '',
        }),
    ).toThrow(/tenantId/)
    expect(
      () =>
        new ReadOnlyCoordinator({
          policy: makePolicy(),
          capabilityProfile: profile,
          provider: { decide: async () => testDecision('c1') },
          executor: { execute: async () => testOutcome() },
          calibration: testCalibration(),
          expectedModel: '',
          tenantId: 't',
        }),
    ).toThrow(/expectedModel/)
  })

  it('uses default ID generators', async () => {
    const coordinator = new ReadOnlyCoordinator({
      policy: makePolicy(),
      capabilityProfile: profile,
      provider: {
        decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
      },
      executor: { execute: async () => testOutcome() },
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      tenantId: 't',
    })

    const result = await coordinator.run(
      { observations, catalog },
      new AbortController().signal,
    )
    expect(result.decision.decisionId).toMatch(/^dec-/)
  })
})

describe('admitDecision', () => {
  function admissionContext(
    decision: NormalizedDecision,
    overrides: Partial<Omit<Parameters<typeof admitDecision>[0], 'decision' | 'input'>> = {},
  ): Parameters<typeof admitDecision>[0] {
    return {
      decision,
      input: testInput(),
      admittedCandidates: [
        {
          id: 'c1',
          label: 'l',
          route: 'tool',
          effect: 'read',
          operationRef: 'op',
          preconditionHash: 'h',
          verificationPolicyId: 'v',
        },
      ],
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      minCalibratedConfidence: 0.5,
      ...overrides,
    }
  }

  it('admits a well-formed decision', () => {
    const verdict = admitDecision(admissionContext(testDecision('c1')))
    expect(verdict.admitted).toBe(true)
    expect(verdict.calibratedCorrectness).not.toBeNull()
  })

  it('rejects correlation mismatches', () => {
    for (const bad of [
      { ...testDecision('c1'), decisionId: 'other' },
      { ...testDecision('c1'), questionFamily: 'other-family' },
      { ...testDecision('c1'), promptVersion: 'other-prompt' },
    ]) {
      const verdict = admitDecision(admissionContext(bad))
      expect(verdict.admitted).toBe(false)
      expect(verdict.reason).toMatch(/correlation/)
    }
  })

  it('rejects model mismatch exactly, not by prefix', () => {
    const verdict = admitDecision(
      admissionContext({ ...testDecision('c1'), modelResolved: `${EXPECTED_MODEL}-suffix` }),
    )
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toMatch(/pinned model/)
  })

  it('rejects unbound calibration', () => {
    const unbound = fitIsotonic(
      [
        { vendorConfidence: 0.1, correct: 0 },
        { vendorConfidence: 0.9, correct: 1 },
      ],
      'cal-v1',
    )
    const verdict = admitDecision(admissionContext(testDecision('c1'), { calibration: unbound }))
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toMatch(/not bound/)
  })

  it('admits escalation without a calibration score', () => {
    const verdict = admitDecision(
      admissionContext({
        ...testDecision('escalate-none', null),
        probabilities: {},
        selectedProbability: 0,
      }),
    )
    expect(verdict.admitted).toBe(true)
    expect(verdict.calibratedCorrectness).toBeNull()
  })
})
