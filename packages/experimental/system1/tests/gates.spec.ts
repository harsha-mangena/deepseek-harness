/**
 * Unit tests for the System 1 question builders and the deterministic loop
 * detector. Builders emit Jev-native primitives (choice/score/noul).
 */

import { describe, expect, it } from 'vitest'
import {
  argsKeyOf,
  buildDelegationQuestion,
  buildLoopNudge,
  buildLoopQuestion,
  buildRetryHint,
  buildRetryQuestion,
  buildStrategyHint,
  buildTriageQuestion,
  detectLoop,
  validateDelegation,
  validateLoopAnswer,
  validateRetry,
  validateTriage,
  type ObservedToolCall,
} from '../src/gates.ts'

function call(name: string, argsKey = '{}', isError = false): ObservedToolCall {
  return { name, argsKey, isError, at: Date.now() }
}

describe('detectLoop', () => {
  it('reports no loop for empty history', () => {
    expect(detectLoop([])).toEqual({ looping: false, repetitions: 0, suggestion: 'continue' })
  })

  it('counts consecutive identical calls', () => {
    const history = [call('read'), call('read'), call('read')]
    const verdict = detectLoop(history, 3)
    expect(verdict.looping).toBe(true)
    expect(verdict.repetitions).toBe(3)
    expect(verdict.suggestion).toBe('ask-user')
  })

  it('suggests interrupt when the repeated calls are failing', () => {
    const history = [call('exec', '{}', true), call('exec', '{}', true), call('exec', '{}', true)]
    expect(detectLoop(history, 3).suggestion).toBe('interrupt')
  })

  it('does not flag different arguments as a loop', () => {
    const history = [call('read', '{"a":1}'), call('read', '{"a":2}'), call('read', '{"a":3}')]
    expect(detectLoop(history, 3).looping).toBe(false)
  })

  it('does not flag different tools as a loop', () => {
    const history = [call('read'), call('write'), call('read')]
    expect(detectLoop(history, 2).looping).toBe(false)
  })

  it('only counts the trailing run', () => {
    const history = [call('write'), call('read'), call('read')]
    const verdict = detectLoop(history, 3)
    expect(verdict.looping).toBe(false)
    expect(verdict.repetitions).toBe(2)
  })

  it('reports no loop for a sparse history with no last entry', () => {
    const sparse = Array.from({ length: 1 }) as ObservedToolCall[]
    expect(detectLoop(sparse)).toEqual({ looping: false, repetitions: 0, suggestion: 'continue' })
  })
})

describe('question builders', () => {
  it('builds a triage choice with criteria', () => {
    const q = buildTriageQuestion([{ role: 'user', content: 'hi' }])
    expect(q.kind).toBe('triage')
    expect(q.primitive).toBe('choice')
    expect(Object.keys(q.options ?? {}).sort()).toEqual(['complex', 'standard', 'trivial'])
    expect(q.prompt.length).toBeGreaterThan(0)
  })

  it('skips messages that fail JSON serialization', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const q = buildTriageQuestion([circular])
    expect(q.kind).toBe('triage')
  })

  it('builds a loop-check noul over recent history', () => {
    const q = buildLoopQuestion([call('read'), call('read')])
    expect(q.kind).toBe('loop-check')
    expect(q.primitive).toBe('noul')
    expect(q.options).toBeUndefined()
    expect((q.context['history'] as unknown[])).toHaveLength(2)
  })

  it('builds a retry choice naming the tool', () => {
    const q = buildRetryQuestion('exec', '{"cmd":"x"}', 'exit 1')
    expect(q.kind).toBe('retry-judgment')
    expect(q.primitive).toBe('choice')
    expect(Object.keys(q.options ?? {}).sort()).toEqual(['give-up', 'retry', 'retry-different'])
    expect(q.context['toolName']).toBe('exec')
  })

  it('builds a delegation choice', () => {
    const q = buildDelegationQuestion('summarize this file')
    expect(q.kind).toBe('delegation')
    expect(q.primitive).toBe('choice')
    expect(Object.keys(q.options ?? {}).sort()).toEqual(['delegate', 'keep'])
  })
})

describe('validators', () => {
  it('validates triage verdicts', () => {
    expect(validateTriage('trivial')).toBe('trivial')
    expect(validateTriage('complex')).toBe('complex')
    expect(validateTriage('maybe')).toBeNull()
    expect(validateTriage(42)).toBeNull()
  })

  it('validates retry answers', () => {
    expect(validateRetry('retry')).toBe('retry')
    expect(validateRetry('give-up')).toBe('give-up')
    expect(validateRetry('later')).toBeNull()
  })

  it('validates delegation answers', () => {
    expect(validateDelegation('delegate')).toBe(true)
    expect(validateDelegation('keep')).toBe(false)
    expect(validateDelegation('yes')).toBeNull()
    expect(validateDelegation('perhaps')).toBeNull()
  })

  it('validates loop-check noul probabilities', () => {
    expect(validateLoopAnswer(0.9)).toBe(0.9)
    expect(validateLoopAnswer(0)).toBe(0)
    expect(validateLoopAnswer(1.5)).toBeNull()
    expect(validateLoopAnswer(-0.1)).toBeNull()
    expect(validateLoopAnswer('high')).toBeNull()
    expect(validateLoopAnswer(null)).toBeNull()
  })
})

describe('argsKeyOf', () => {
  it('produces stable keys', () => {
    expect(argsKeyOf({ a: 1 })).toBe(argsKeyOf({ a: 1 }))
  })

  it('falls back for circular structures', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(typeof argsKeyOf(circular)).toBe('string')
  })

  it('stringifies values JSON cannot represent', () => {
    expect(argsKeyOf(undefined)).toBe('undefined')
  })
})

describe('buildStrategyHint', () => {
  it('maps trivial to direct atomic reasoning', () => {
    const hint = buildStrategyHint('trivial')
    expect(hint).toContain('[System 1 triage: trivial]')
    expect(hint).toContain('minimal deliberation')
  })

  it('maps standard to step-by-step reasoning', () => {
    const hint = buildStrategyHint('standard')
    expect(hint).toContain('[System 1 triage: standard]')
    expect(hint).toContain('step-by-step')
  })

  it('maps complex to atomic decomposition with alternatives', () => {
    const hint = buildStrategyHint('complex')
    expect(hint).toContain('[System 1 triage: complex]')
    expect(hint).toContain('atomic sub-steps')
    expect(hint).toContain('2–3 alternative')
  })
})

describe('buildLoopNudge', () => {
  it('names the tool, count, and probability', () => {
    const nudge = buildLoopNudge('read_note', 4, 0.86, 'interrupt')
    expect(nudge).toContain('[System 1 loop-check]')
    expect(nudge).toContain('"read_note" ×4')
    expect(nudge).toContain('0.86')
    expect(nudge).toContain('interrupt')
  })

  it('handles an unknown probability from the deterministic detector', () => {
    expect(buildLoopNudge('calc', 3, null, 'ask-user')).toContain('unknown')
  })
})

describe('buildRetryHint', () => {
  it('advises retry for transient failures', () => {
    expect(buildRetryHint('retry', 'fetch')).toContain('retrying the identical call is reasonable')
  })

  it('advises different arguments when the call was wrong', () => {
    expect(buildRetryHint('retry-different', 'fetch')).toContain('different arguments')
  })

  it('advises giving up when retrying looks futile', () => {
    expect(buildRetryHint('give-up', 'fetch')).toContain('do not retry')
  })
})
