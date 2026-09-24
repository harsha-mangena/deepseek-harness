/**
 * Phase 0 regression fixtures: two reference-controller hazards reproduced
 * as local, runnable contracts. Recorded from offline SystemOneHarness
 * probes; they are not live Jev accuracy measurements.
 *
 * 1. `false-guard-blocks`: an arbitrary guard question returning false must
 *    block its candidate. The live execution proof (a denying
 *    `tools/pre-execute` guard stops the tool body) lives in
 *    `guarded-tool-probe.spec.ts`; this file pins the decision-level
 *    invariant the phase 1 policy engine must implement: a required guard
 *    answering false blocks dispatch.
 * 2. `repeated-finish-unmet-goal`: repeated FINISH with an unmet goal must
 *    never succeed. The event vocabulary carries the scenario, the type
 *    contract makes an unevidenced success terminal unrepresentable, and
 *    the fixture-level invariant forbids success while no verifier passed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  System1DecisionData,
  System1TerminalData,
  System1VerificationData,
} from '@deepseek-ai/dsh-system1-workflow'
import { System1RequestId } from '@deepseek-ai/dsh-system1-workflow'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'))
}

interface GuardEvaluation {
  guardId: string
  question: string
  required: boolean
  answer: boolean
}

interface GuardFixture {
  hazard: string
  requestId: string
  candidate: { id: string; requiredGuards: string[] }
  guardEvaluations: GuardEvaluation[]
  expectedOutcome: string
  expectedBlockedBy: string[]
}

interface FinishFixture {
  hazard: string
  requestId: string
  goal: string
  decisions: Array<{ seq: number; questionId: string; choice: string; confidence: number }>
  verifications: Array<{ checkId: string; passed: boolean; evidence: string }>
  expectedTerminalOutcome: string
  forbiddenTerminalOutcome: string
}

/**
 * Phase-0 expression of the guard invariant: a required guard answering
 * false blocks dispatch. The phase 1 policy engine owns this rule; the
 * fixture pins it here so the contract cannot regress before the engine
 * exists.
 */
function guardBlocks(evaluations: GuardEvaluation[], requiredGuards: string[]): string[] {
  return requiredGuards.filter(guardId =>
    evaluations.some(evaluation => evaluation.guardId === guardId && evaluation.required && !evaluation.answer),
  )
}

/**
 * Phase-0 expression of the terminal invariant: success is only legal when
 * at least one verifier check passed. The phase 1 policy engine owns this
 * rule; the fixture pins it here so the contract cannot regress before the
 * engine exists.
 */
function mayDeclareSuccess(verifications: Array<{ passed: boolean }>): boolean {
  return verifications.some(verification => verification.passed)
}

describe('regression fixture: false guard blocks', () => {
  it('a required guard answering false blocks the candidate', () => {
    const fixture = loadFixture('false-guard-blocks.json') as GuardFixture
    expect(fixture.hazard).toBe('false-guard-blocks')

    const blockedBy = guardBlocks(fixture.guardEvaluations, fixture.candidate.requiredGuards)
    expect(blockedBy).toEqual(fixture.expectedBlockedBy)
    expect(blockedBy.length).toBeGreaterThan(0)
    expect(fixture.expectedOutcome).toBe('blocked')
  })

  it('the guard answers survive a session round-trip', () => {
    const fixture = loadFixture('false-guard-blocks.json') as GuardFixture
    const session = Session.create(SessionId('fixture-guard-1'))
    const requestId = System1RequestId(fixture.requestId)
    for (const evaluation of fixture.guardEvaluations) {
      session.append('system1/verification', {
        schemaVersion: 1,
        requestId,
        checkId: evaluation.guardId,
        passed: evaluation.answer,
        evidence: evaluation.question,
      } satisfies System1VerificationData)
    }
    const logged = session.snapshotEvents().filter(event => event.type === 'system1/verification')
    expect(logged).toHaveLength(fixture.guardEvaluations.length)
    expect(
      logged.every(
        event =>
          event.type === 'system1/verification'
          && event.data.requestId === fixture.requestId,
      ),
    ).toBe(true)
  })
})

describe('regression fixture: repeated FINISH with unmet goal', () => {
  it('never yields a success terminal while no verifier passed', () => {
    const fixture = loadFixture('repeated-finish-unmet-goal.json') as FinishFixture
    expect(fixture.hazard).toBe('repeated-finish-unmet-goal')
    expect(fixture.decisions.every(decision => decision.choice === 'FINISH')).toBe(true)

    expect(mayDeclareSuccess(fixture.verifications)).toBe(false)
    expect(fixture.forbiddenTerminalOutcome).toBe('success')
    expect(fixture.expectedTerminalOutcome).not.toBe('success')
  })

  it('records the decision and verification trail in the session log', () => {
    const fixture = loadFixture('repeated-finish-unmet-goal.json') as FinishFixture
    const session = Session.create(SessionId('fixture-finish-1'))
    const requestId = System1RequestId(fixture.requestId)
    for (const decision of fixture.decisions) {
      session.append('system1/decision', {
        schemaVersion: 1,
        requestId,
        primitive: 'choice',
        candidateId: 'finish',
        confidence: decision.confidence,
        model: 'fixture',
      } satisfies System1DecisionData)
    }
    for (const verification of fixture.verifications) {
      session.append('system1/verification', {
        schemaVersion: 1,
        requestId,
        checkId: verification.checkId,
        passed: verification.passed,
        evidence: verification.evidence,
      } satisfies System1VerificationData)
    }
    const logged = session.snapshotEvents().filter(
      event => event.type === 'system1/decision' || event.type === 'system1/verification',
    )
    expect(logged).toHaveLength(
      fixture.decisions.length + fixture.verifications.length,
    )
  })

  it('the terminal contract requires verification evidence for success', () => {
    const success: Extract<System1TerminalData, { outcome: 'success' }> = {
      schemaVersion: 1,
      requestId: System1RequestId('fixture'),
      outcome: 'success',
      summary: 'verified',
      verifiedBy: ['verify-row-counts'],
    }
    expect(success.verifiedBy).toEqual(['verify-row-counts'])
    // A success terminal without evidence does not typecheck:
    // @ts-expect-error verifiedBy is required on the success branch
    const _unevidenced: System1TerminalData = {
      schemaVersion: 1,
      requestId: System1RequestId('fixture'),
      outcome: 'success',
      summary: 'must not compile',
    }
    expect(_unevidenced).toBeDefined()
  })
})
