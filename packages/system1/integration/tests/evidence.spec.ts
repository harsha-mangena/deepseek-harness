/** Stored-evidence unit tests: the finalizer's session-log projections.
 *
 * These tests cover the pure evidence helpers directly against crafted
 * session logs: sanitization, hashing, receipt parsing, pre-dispatch
 * recording, tool evidence persistence, and the check-resolution,
 * terminal-idempotency, and handoff-resolution gates the driver relies on.
 * Driver-level tests (restart resolution, repeated finalization, missing
 * evidence) live in `driver.spec.ts`, which owns the boot helpers.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { System1RequestId } from '@deepseek-ai/dsh-system1-workflow'
import type { NormalizedDecision } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate } from '@deepseek-ai/dsh-system1-contracts'
import {
  buildEscalationBundle,
  finalizeOnce,
  findStoredToolResult,
  hasTerminal,
  hashEvidenceContent,
  loadEvidenceBinding,
  loadStoredVerifications,
  nextToolStep,
  parseReceiptRef,
  recordDispatchPlan,
  recordToolEvidence,
  resolveCheckEvidence,
  resolveHandoffRefs,
  sanitizeToolResultContent,
  serializeArguments,
  MAX_EVIDENCE_CHARS,
  evidenceText,
} from '@deepseek-ai/dsh-system1-integration'
import type { EvidenceSpillStore } from '@deepseek-ai/dsh-system1-integration'

const REQUEST_ID = System1RequestId('req-unit')

function toolSuccess(text: string): ToolExecutionSuccess {
  return {
    isError: false,
    value: { text },
    content: [{ type: 'text', text }],
  }
}

function testCandidate(): Candidate {
  return {
    id: 'c1',
    label: 'Read CI runs',
    route: 'tool',
    effect: 'read',
    operationRef: 'op:ci-runs:read:v1',
    preconditionHash: 'precon',
    verificationPolicyId: 'verify:ci:v1',
  }
}

function testDecision(overrides: Partial<NormalizedDecision> = {}): NormalizedDecision {
  return {
    decisionId: 'd1',
    questionFamily: 'select-candidate',
    promptVersion: 'p1',
    selectedId: 'c1',
    probabilities: { c1: 0.8 },
    selectedProbability: 0.8,
    vendorConfidence: 0.9,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: 'jev-test-v1',
    modelResolved: 'jev-test-v1',
    requestId: null,
    usage: { inputTokens: null, outputTokens: null },
    reasonCode: 'accepted',
    ...overrides,
  }
}

/** A session holding one dispatch's tool evidence plus its verification. */
async function evidenceSession(checkId = 'check-1'): Promise<{
  session: Session
  evidenceHash: string
}> {
  const session = Session.create(SessionId('s-evidence-unit'))
  const { evidenceHash } = await recordToolEvidence(session, {
    turn: 0,
    step: 0,
    callId: ToolCallId('call-1'),
    name: 'ci-status',
    argsJson: '{}',
    result: toolSuccess('CI is green'),
  })
  session.append('system1/verification', {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    checkId,
    passed: true,
    evidence: 'tool-call:call-1',
  })
  return { session, evidenceHash }
}

describe('serializeArguments', () => {
  it('serializes arguments to canonical JSON', () => {
    expect(serializeArguments({ branch: 'main' })).toBe('{"branch":"main"}')
  })

  it('falls back to null for non-serializable arguments', () => {
    expect(serializeArguments(undefined)).toBe('null')
  })
})

describe('sanitizeToolResultContent', () => {
  it('keeps visible text blocks', () => {
    const sanitized = sanitizeToolResultContent([{ type: 'text', text: 'CI is green' }])
    expect(sanitized).toEqual([{ type: 'text', text: 'CI is green' }])
  })

  it('redacts secrets from text blocks', () => {
    const sanitized = sanitizeToolResultContent([
      { type: 'text', text: 'deploy password: s3cret-value' },
    ])
    expect(sanitized).toHaveLength(1)
    expect(sanitized[0]?.text).toContain('[REDACTED]')
    expect(sanitized[0]?.text).not.toContain('s3cret-value')
  })

  it('drops empty text blocks', () => {
    const sanitized = sanitizeToolResultContent([
      { type: 'text', text: '   ' },
      { type: 'text', text: 'kept' },
    ])
    expect(sanitized).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('replaces non-text blocks with placeholders', () => {
    const blocks: ContentBlock[] = [
      { type: 'reasoning', text: 'internal thinking' },
      { type: 'text', text: 'visible' },
    ]
    const sanitized = sanitizeToolResultContent(blocks)
    expect(sanitized).toEqual([
      { type: 'text', text: '[omitted reasoning block from verification evidence]' },
      { type: 'text', text: 'visible' },
    ])
  })
})

describe('hashEvidenceContent', () => {
  it('is deterministic hex over the block texts', () => {
    const first = hashEvidenceContent([{ type: 'text', text: 'CI is green' }])
    const second = hashEvidenceContent([{ type: 'text', text: 'CI is green' }])
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the content changes', () => {
    const first = hashEvidenceContent([{ type: 'text', text: 'green' }])
    const second = hashEvidenceContent([{ type: 'text', text: 'red' }])
    expect(first).not.toBe(second)
  })

  it('ignores non-text blocks', () => {
    const withReasoning = hashEvidenceContent([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'green' },
    ])
    const textOnly = hashEvidenceContent([{ type: 'text', text: 'green' }])
    expect(withReasoning).toBe(textOnly)
  })
})

describe('parseReceiptRef', () => {
  it('parses a well-formed receipt', () => {
    expect(parseReceiptRef('tool-call:call-1')).toBe('call-1')
  })

  it('rejects a missing prefix', () => {
    expect(parseReceiptRef('bogus')).toBeUndefined()
  })

  it('rejects an empty call id', () => {
    expect(parseReceiptRef('tool-call:')).toBeUndefined()
  })
})

describe('nextToolStep', () => {
  it('starts at zero on an empty log', () => {
    const session = Session.create(SessionId('s-step-empty'))
    expect(nextToolStep(session)).toEqual({ turn: 0, step: 0 })
  })

  it('counts completed turns and tool calls', () => {
    const session = Session.create(SessionId('s-step-counts'))
    session.append('system1/decision', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      primitive: 'choice',
      candidateId: 'c1',
      model: 'jev-test-v1',
    })
    session.append('tool/call', {
      turn: 0,
      step: 0,
      callId: ToolCallId('call-1'),
      name: 'ci-status',
      arguments: '{}',
    })
    session.append('system1/terminal', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      outcome: 'success',
      summary: 'done',
      verifiedBy: ['check-1'],
    })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-2'),
      name: 'ci-status',
      arguments: '{}',
    })
    expect(nextToolStep(session)).toEqual({ turn: 1, step: 2 })
  })
})

describe('recordDispatchPlan', () => {
  it('records the decision, execution intent, and dispatch plan before dispatch', () => {
    const session = Session.create(SessionId('s-plan'))
    recordDispatchPlan(session, {
      requestId: REQUEST_ID,
      candidate: testCandidate(),
      decision: testDecision(),
      callName: 'ci-status',
      argsJson: '{"branch":"main"}',
      expectedModel: 'jev-test-v1',
    })
    const events = session.snapshotEvents()

    const decision = events.find((event) => event.type === 'system1/decision')
    expect(decision?.data).toMatchObject({
      primitive: 'choice',
      candidateId: 'c1',
      confidence: 0.9,
      model: 'jev-test-v1',
    })

    const intent = events.find((event) => event.type === 'system1/execution-intent')
    expect(intent?.data).toMatchObject({
      steps: [
        {
          id: 'step-1',
          tool: 'ci-status',
          reversible: true,
        },
      ],
    })

    const plan = events.find((event) => event.type === 'system1/dispatch-plan')
    expect(plan?.data).toMatchObject({
      decisionId: 'd1',
      admission: 'admit',
      candidateId: 'c1',
      operationRef: 'op:ci-runs:read:v1',
      attempt: 1,
      argumentDigest: hashEvidenceContent([{ type: 'text', text: '{"branch":"main"}' }]),
    })
  })

  it('falls back to the expected model when the decision resolved none', () => {
    const session = Session.create(SessionId('s-plan-model'))
    recordDispatchPlan(session, {
      requestId: REQUEST_ID,
      candidate: testCandidate(),
      decision: testDecision({ modelResolved: null }),
      callName: 'ci-status',
      argsJson: '{}',
      expectedModel: 'jev-test-v1',
    })
    const decision = session
      .snapshotEvents()
      .find((event) => event.type === 'system1/decision')
    expect(decision?.data).toMatchObject({ model: 'jev-test-v1' })
  })

  it('refuses to plan a dispatch without vendor confidence', () => {
    const session = Session.create(SessionId('s-plan-noconf'))
    expect(() =>
      recordDispatchPlan(session, {
        requestId: REQUEST_ID,
        candidate: testCandidate(),
        decision: testDecision({ vendorConfidence: null }),
        callName: 'ci-status',
        argsJson: '{}',
        expectedModel: 'jev-test-v1',
      }),
    ).toThrow(/vendor confidence/)
  })
})

describe('recordToolEvidence', () => {
  it('persists the tool call and the sanitized result, linked by seq', async () => {
    const session = Session.create(SessionId('s-tool-evidence'))
    const { evidenceHash } = await recordToolEvidence(session, {
      turn: 0,
      step: 0,
      callId: ToolCallId('call-9'),
      name: 'ci-status',
      argsJson: '{"branch":"main"}',
      result: toolSuccess('CI is green'),
    })
    const events = session.snapshotEvents()
    const call = events.find((event) => event.type === 'tool/call')
    const result = events.find((event) => event.type === 'tool/result')
    expect(call?.data).toMatchObject({
      turn: 0,
      step: 0,
      callId: 'call-9',
      name: 'ci-status',
      arguments: '{"branch":"main"}',
    })
    expect(result?.data.message.toolCallId).toBe('call-9')
    expect(result?.data.message.content).toEqual([{ type: 'text', text: 'CI is green' }])
    expect(result && 'sourceEventSeqs' in result && result.sourceEventSeqs).toEqual([call?.seq])
    expect(evidenceHash).toBe(hashEvidenceContent([{ type: 'text', text: 'CI is green' }]))
  })
})

describe('oversized tool evidence', () => {
  const bigText = 'x'.repeat(MAX_EVIDENCE_CHARS + 1)

  function fakeStore(fail = false): EvidenceSpillStore {
    return {
      saveText: (input) => {
        if (fail) return Promise.reject(new Error('spill unavailable'))
        return Promise.resolve({ locator: 'spill://tenant-a/result', bytes: input.content.length })
      },
    }
  }

  function toolEvidenceArgs(spill?: {
    store: EvidenceSpillStore
    tenantId: string
  }): Parameters<typeof recordToolEvidence>[1] {
    return {
      turn: 0,
      step: 0,
      callId: ToolCallId('call-big'),
      name: 'big-tool',
      argsJson: '{}',
      result: toolSuccess(bigText),
      ...(spill === undefined ? {} : { spill }),
    }
  }

  function storedText(session: Session): string {
    const stored = findStoredToolResult(session, ToolCallId('call-big'))
    expect(stored).toBeDefined()
    return stored === undefined ? '' : evidenceText(stored.data.message.content)
  }

  it('spills oversized results by reference and hashes the full text', async () => {
    const session = Session.create(SessionId('s-spill'))
    const { evidenceHash, spilled } = await recordToolEvidence(
      session,
      toolEvidenceArgs({ store: fakeStore(), tenantId: 'tenant-a' }),
    )
    if (spilled === undefined) throw new Error('expected a spill reference')
    expect(spilled.locator).toBe('spill://tenant-a/result')
    expect(spilled.bytes).toBe(bigText.length)
    expect(spilled.tenantId).toBe('tenant-a')
    expect(spilled.sessionId).toBe('s-spill')
    // The inline evidence stays bounded: a pointer block, not the result.
    const text = storedText(session)
    expect(text).toContain('spilled to spill://tenant-a/result')
    expect(text).not.toContain(bigText)
    expect(text.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS)
    // The returned hash commits to the full text the store holds.
    expect(evidenceHash).toBe(spilled.contentHash)
    expect(evidenceHash).toBe(hashEvidenceContent([{ type: 'text', text: bigText }]))
  })

  it('keeps results at the inline bound stored inline', async () => {
    const session = Session.create(SessionId('s-spill-bound'))
    const atBound = 'y'.repeat(MAX_EVIDENCE_CHARS)
    const { evidenceHash, spilled } = await recordToolEvidence(session, {
      turn: 0,
      step: 0,
      callId: ToolCallId('call-bound'),
      name: 'big-tool',
      argsJson: '{}',
      result: toolSuccess(atBound),
      spill: { store: fakeStore(), tenantId: 'tenant-a' },
    })
    expect(spilled).toBeUndefined()
    expect(evidenceHash).toBe(hashEvidenceContent([{ type: 'text', text: atBound }]))
  })

  it('truncates oversized results inline when no spill store is available', async () => {
    const session = Session.create(SessionId('s-spill-none'))
    const { evidenceHash, spilled } = await recordToolEvidence(
      session,
      toolEvidenceArgs(),
    )
    expect(spilled).toBeUndefined()
    const text = storedText(session)
    expect(text.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS)
    expect(text).toContain('truncated')
    // The hash commits to exactly what was stored.
    const stored = findStoredToolResult(session, ToolCallId('call-big'))
    expect(evidenceHash).toBe(
      hashEvidenceContent(stored === undefined ? [] : stored.data.message.content),
    )
  })

  it('truncates inline when the spill store rejects', async () => {
    const session = Session.create(SessionId('s-spill-fail'))
    const { evidenceHash, spilled } = await recordToolEvidence(
      session,
      toolEvidenceArgs({ store: fakeStore(true), tenantId: 'tenant-a' }),
    )
    expect(spilled).toBeUndefined()
    const text = storedText(session)
    expect(text.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS)
    expect(text).toContain('truncated')
    expect(evidenceHash).not.toBe(hashEvidenceContent([{ type: 'text', text: bigText }]))
  })

  it('joins text blocks in order for spill storage', () => {
    expect(
      evidenceText([
        { type: 'text', text: 'first' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond')
  })

  /** A session holding a spilled result, its verification, and its binding. */
  async function spilledSession(): Promise<{
    session: Session
    evidenceHash: string
  }> {
    const session = Session.create(SessionId('s-spilled-check'))
    const { evidenceHash, spilled } = await recordToolEvidence(
      session,
      toolEvidenceArgs({ store: fakeStore(), tenantId: 'tenant-a' }),
    )
    if (spilled === undefined) throw new Error('expected a spill reference')
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-1',
      passed: true,
      evidence: 'tool-call:call-big',
    })
    session.append('system1/evidence-binding', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-1',
      verifierVersion: 'verify:ci:v1',
      resourceVersions: { 'tool-call:call-big': evidenceHash },
      spill: spilled,
    })
    return { session, evidenceHash }
  }

  it('resolves a check against the spilled full-text hash', async () => {
    const { session, evidenceHash } = await spilledSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-big',
        expectedHash: evidenceHash,
        expectedTenantId: 'tenant-a',
      },
    ])
    expect(resolution).toEqual({
      ok: true,
      checks: [
        {
          checkId: 'check-1',
          receiptRef: 'tool-call:call-big',
          evidenceHash,
          verification: { checkId: 'check-1', passed: true },
        },
      ],
    })
  })

  it('rejects a spill owned by another tenant', async () => {
    const { session, evidenceHash } = await spilledSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-big',
        expectedHash: evidenceHash,
        expectedTenantId: 'tenant-b',
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'spill for check "check-1" is owned by another tenant',
    })
  })

  it('rejects when the spilled hash does not match the dispatched evidence', async () => {
    const { session } = await spilledSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-big',
        expectedHash: 'deadbeef',
        expectedTenantId: 'tenant-a',
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason:
        'stored tool/result for "tool-call:call-big" does not match the dispatched evidence',
    })
  })

  it('loads the evidence binding for a check', async () => {
    const { session } = await spilledSession()
    const binding = loadEvidenceBinding(session, REQUEST_ID, 'check-1')
    expect(binding?.verifierVersion).toBe('verify:ci:v1')
    expect(binding?.spill?.tenantId).toBe('tenant-a')
    expect(loadEvidenceBinding(session, REQUEST_ID, 'check-missing')).toBeUndefined()
  })
})

describe('findStoredToolResult', () => {
  it('finds the stored result by call id', async () => {
    const { session } = await evidenceSession()
    const found = findStoredToolResult(session, ToolCallId('call-1'))
    expect(found?.data.message.toolCallId).toBe('call-1')
  })

  it('returns undefined when no result was stored', async () => {
    const { session } = await evidenceSession()
    expect(findStoredToolResult(session, ToolCallId('call-missing'))).toBeUndefined()
  })
})

describe('loadStoredVerifications', () => {
  it('loads only the request’s verification records in log order', async () => {
    const { session } = await evidenceSession('check-a')
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: System1RequestId('req-other'),
      checkId: 'check-other',
      passed: true,
      evidence: 'tool-call:call-1',
    })
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-b',
      passed: false,
      evidence: 'tool-call:call-1',
    })
    expect(loadStoredVerifications(session, REQUEST_ID)).toEqual([
      { checkId: 'check-a', passed: true, evidence: 'tool-call:call-1' },
      { checkId: 'check-b', passed: false, evidence: 'tool-call:call-1' },
    ])
  })
})

describe('resolveCheckEvidence', () => {
  it('resolves when the stored check cites the dispatched receipt with matching evidence', async () => {
    const { session, evidenceHash } = await evidenceSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-1',
        expectedHash: evidenceHash,
      },
    ])
    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.checks).toHaveLength(1)
      expect(resolution.checks[0]).toMatchObject({
        checkId: 'check-1',
        receiptRef: 'tool-call:call-1',
        evidenceHash,
        verification: { checkId: 'check-1', passed: true },
      })
    }
  })

  it('rejects when no verification was stored for the check', async () => {
    const { session, evidenceHash } = await evidenceSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      { checkId: 'check-missing', expectedReceiptRef: 'tool-call:call-1', expectedHash: evidenceHash },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'no stored verification for check "check-missing"',
    })
  })

  it('rejects when the stored verification did not pass', async () => {
    const { session, evidenceHash } = await evidenceSession()
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-failed',
      passed: false,
      evidence: 'tool-call:call-1',
    })
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-failed',
        expectedReceiptRef: 'tool-call:call-1',
        expectedHash: evidenceHash,
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'stored verification for check "check-failed" did not pass',
    })
  })

  it('rejects when the check cites a different receipt', async () => {
    const { session, evidenceHash } = await evidenceSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-2',
        expectedHash: evidenceHash,
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'check "check-1" cites "tool-call:call-1", expected "tool-call:call-2"',
    })
  })

  it('rejects when the cited receipt is malformed', async () => {
    const session = Session.create(SessionId('s-resolve-bogus'))
    const { evidenceHash } = await recordToolEvidence(session, {
      turn: 0,
      step: 0,
      callId: ToolCallId('call-1'),
      name: 'ci-status',
      argsJson: '{}',
      result: toolSuccess('CI is green'),
    })
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-bogus',
      passed: true,
      evidence: 'bogus',
    })
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      { checkId: 'check-bogus', expectedReceiptRef: 'bogus', expectedHash: evidenceHash },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'check "check-bogus" cites malformed receipt "bogus"',
    })
  })

  it('rejects when no tool/result was stored for the receipt', async () => {
    const { session, evidenceHash } = await evidenceSession()
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      checkId: 'check-orphan',
      passed: true,
      evidence: 'tool-call:call-missing',
    })
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-orphan',
        expectedReceiptRef: 'tool-call:call-missing',
        expectedHash: evidenceHash,
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason: 'no stored tool/result for receipt "tool-call:call-missing"',
    })
  })

  it('rejects when the stored result does not match the dispatched evidence', async () => {
    const { session } = await evidenceSession()
    const resolution = resolveCheckEvidence(session, REQUEST_ID, [
      {
        checkId: 'check-1',
        expectedReceiptRef: 'tool-call:call-1',
        expectedHash: 'deadbeef',
      },
    ])
    expect(resolution).toEqual({
      ok: false,
      reason:
        'stored tool/result for "tool-call:call-1" does not match the dispatched evidence',
    })
  })
})

describe('hasTerminal and finalizeOnce', () => {
  function successRequest(session: Session, requestId: ReturnType<typeof System1RequestId>): void {
    finalizeOnce({
      session,
      requestId,
      outcome: 'success',
      summary: 'done',
      verifiedBy: ['check-1'],
      verifications: [{ checkId: 'check-1', passed: true }],
    })
  }

  it('reports no terminal on an empty log', () => {
    const session = Session.create(SessionId('s-terminal-empty'))
    expect(hasTerminal(session, REQUEST_ID)).toBe(false)
  })

  it('finds the terminal for the request but not for others', () => {
    const session = Session.create(SessionId('s-terminal-find'))
    successRequest(session, REQUEST_ID)
    expect(hasTerminal(session, REQUEST_ID)).toBe(true)
    expect(hasTerminal(session, System1RequestId('req-other'))).toBe(false)
  })

  it('finalizes a repeated request id exactly once', () => {
    const session = Session.create(SessionId('s-terminal-once'))
    successRequest(session, REQUEST_ID)
    successRequest(session, REQUEST_ID)
    const terminals = session
      .snapshotEvents()
      .filter((event) => event.type === 'system1/terminal')
    expect(terminals).toHaveLength(1)
  })

  it('finalizes distinct request ids independently', () => {
    const session = Session.create(SessionId('s-terminal-distinct'))
    successRequest(session, REQUEST_ID)
    successRequest(session, System1RequestId('req-other'))
    const terminals = session
      .snapshotEvents()
      .filter((event) => event.type === 'system1/terminal')
    expect(terminals).toHaveLength(2)
  })
})

describe('resolveHandoffRefs', () => {
  function bundle() {
    return buildEscalationBundle({
      requestId: REQUEST_ID,
      observations: [],
      decision: testDecision({ selectedId: 'escalate-none', vendorConfidence: null }),
      reason: 'test escalation',
      budget: { poolName: 'pool-main', units: 10 },
      tenantId: 'tenant-test',
    })
  }

  it('resolves well-formed references against an empty return contract', () => {
    const resolutions = resolveHandoffRefs(bundle(), {
      kind: 'completed',
      artifacts: [],
      evidence: ['evidence:ci-log'],
      actualUnits: 1,
    })
    expect(resolutions).toEqual([{ ref: 'evidence:ci-log', resolved: true }])
  })

  it('rejects empty references', () => {
    const resolutions = resolveHandoffRefs(bundle(), {
      kind: 'completed',
      artifacts: [],
      evidence: [''],
      actualUnits: 1,
    })
    expect(resolutions).toEqual([
      { ref: '', resolved: false, reason: 'empty evidence reference' },
    ])
  })

  it('rejects references when the return contract is not satisfied', () => {
    const contracted = {
      ...bundle(),
      returnContract: { requiredArtifacts: [], requiredEvidence: ['evidence:required'] },
    }
    const resolutions = resolveHandoffRefs(contracted, {
      kind: 'completed',
      artifacts: [],
      evidence: ['evidence:other'],
      actualUnits: 1,
    })
    expect(resolutions).toEqual([
      {
        ref: 'evidence:other',
        resolved: false,
        reason: 'return contract not satisfied: evidence:evidence:required',
      },
    ])
  })
})
