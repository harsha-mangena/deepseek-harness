/**
 * Unit tests for the System 1 question builders and the deterministic loop
 * detector.
 */

import { describe, expect, it } from 'vitest'
import {
  argsKeyOf,
  buildDelegationQuestion,
  buildLoopQuestion,
  buildRetryQuestion,
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
})

describe('question builders', () => {
  it('builds a triage question with the right kind and schema', () => {
    const q = buildTriageQuestion([{ role: 'user', content: 'hi' }])
    expect(q.kind).toBe('triage')
    expect(q.answerSchema).toBe('triage')
    expect(q.prompt).toContain('trivial')
  })

  it('builds a loop question over recent history', () => {
    const q = buildLoopQuestion([call('read'), call('read')])
    expect(q.kind).toBe('loop-check')
    expect((q.context['history'] as unknown[])).toHaveLength(2)
  })

  it('builds a retry question naming the tool', () => {
    const q = buildRetryQuestion('exec', '{"cmd":"x"}', 'exit 1')
    expect(q.kind).toBe('retry-judgment')
    expect(q.context['toolName']).toBe('exec')
  })

  it('builds a delegation question', () => {
    const q = buildDelegationQuestion('summarize this file')
    expect(q.kind).toBe('delegation')
    expect(q.answerSchema).toBe('boolean')
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
    expect(validateDelegation('yes')).toBe(true)
    expect(validateDelegation(false)).toBe(false)
    expect(validateDelegation('perhaps')).toBeNull()
  })

  it('validates loop-check answers', () => {
    expect(validateLoopAnswer({ looping: true, suggestion: 'interrupt' })).toEqual({
      looping: true,
      repetitions: 0,
      suggestion: 'interrupt',
    })
    expect(validateLoopAnswer({ looping: false, suggestion: 'bogus' })?.suggestion).toBe('continue')
    expect(validateLoopAnswer({ looping: 'yes' })).toBeNull()
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
})
