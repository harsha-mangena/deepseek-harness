/**
 * Unit tests for the System 1 question builders and the deterministic loop
 * detector. Builders emit Jev-native primitives (choice/score/noul).
 */

import { describe, expect, it } from 'vitest'
import {
  argsKeyOf,
  buildDelegationHint,
  buildDelegationQuestion,
  buildDelegationScoreQuestions,
  buildFinalAnswerQuestion,
  buildLoopNudge,
  buildLoopQuestion,
  buildRetryHint,
  buildRetryQuestion,
  buildStrategyHint,
  buildToolChoiceQuestion,
  buildToolDenyReason,
  buildTriageQuestion,
  detectLoop,
  extractFinalQa,
  messageText,
  previewMessages,
  previewToolHistory,
  validateDelegation,
  validateDelegationScore,
  validateFinalAnswer,
  validateLoopAnswer,
  validateRetry,
  validateToolChoice,
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
    expect(Object.keys(q.options ?? {}).sort()).toEqual(['give-up', 'replan', 'retry', 'retry-different'])
    expect(q.context['toolName']).toBe('exec')
    // Advisory and cheap to get wrong: gates lower than reasoning-shape advice.
    expect(q.threshold).toBe(0.6)
  })

  it('builds a delegation choice from messages', () => {
    const q = buildDelegationQuestion([{ role: 'user', content: 'summarize this file' }])
    expect(q.kind).toBe('delegation')
    expect(q.primitive).toBe('choice')
    expect(Object.keys(q.options ?? {}).sort()).toEqual(['delegate', 'keep'])
    expect(String(q.context['stepSummary'])).toContain('summarize this file')
    expect(q.threshold).toBe(0.65)
  })

  it('builds a delegation composite: three atomic scores', () => {
    const questions = buildDelegationScoreQuestions('helper', 'do a thing', 'You are helper. do a thing.')
    expect(questions).toHaveLength(3)
    for (const q of questions) {
      expect(q.kind).toBe('delegation-triage')
      expect(q.primitive).toBe('score')
      expect(q.levels).toHaveLength(4)
      expect(q.threshold).toBe(0.6)
    }
    const prompts = questions.map(q => q.prompt)
    expect(prompts[0]).toContain('novel')
    expect(prompts[1]).toContain('risky')
    expect(prompts[2]).toContain('irreversible')
    // Levels describe situations, not degrees.
    expect(questions[0]?.levels?.[0]).toContain('routine')
  })

  it('builds a delegation hint', () => {
    expect(buildDelegationHint()).toContain('[System 1 delegation]')
  })

  it('previews messages as readable role/text lines', () => {
    const preview = previewMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      'bare string',
    ])
    expect(preview).toEqual(['[user] hello', '[assistant] hi there', 'bare string'])
  })

  it('preview never throws on circular messages', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => previewMessages([circular])).not.toThrow()
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
    expect(validateRetry('retry-different')).toBe('retry-different')
    expect(validateRetry('replan')).toBe('replan')
    expect(validateRetry('give-up')).toBe('give-up')
    expect(validateRetry('later')).toBeNull()
  })

  it('validates delegation scores as 0..3 positions', () => {
    expect(validateDelegationScore(0)).toBe(0)
    expect(validateDelegationScore(2.5)).toBe(2.5)
    expect(validateDelegationScore(3)).toBe(3)
    // Out-of-range answers fail validation rather than clamping.
    expect(validateDelegationScore(3.5)).toBeNull()
    expect(validateDelegationScore(-1)).toBeNull()
    expect(validateDelegationScore('high')).toBeNull()
    expect(validateDelegationScore(null)).toBeNull()
    expect(validateDelegationScore(Number.NaN)).toBeNull()
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

  it('validates tool-choice verdicts', () => {
    expect(validateToolChoice('proceed')).toBe('proceed')
    expect(validateToolChoice('wrong-tool')).toBe('wrong-tool')
    expect(validateToolChoice('deny')).toBeNull()
    expect(validateToolChoice(1)).toBeNull()
  })

  it('validates final-answer verdicts', () => {
    expect(validateFinalAnswer('adequate')).toBe('adequate')
    expect(validateFinalAnswer('inadequate')).toBe('inadequate')
    expect(validateFinalAnswer('partial')).toBeNull()
    expect(validateFinalAnswer(null)).toBeNull()
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
  it('maps trivial to a direct answer, suppressing deliberation', () => {
    const hint = buildStrategyHint('trivial')
    expect(hint).toContain('[System 1 triage: trivial]')
    expect(hint).toContain('Answer directly')
    expect(hint).toContain('reasoning errors')
  })

  it('maps standard to a short grounded chain', () => {
    const hint = buildStrategyHint('standard')
    expect(hint).toContain('[System 1 triage: standard]')
    expect(hint).toContain('hypothesis')
    expect(hint).toContain('At most four steps')
  })

  it('maps complex to atom-of-thoughts decomposition', () => {
    const hint = buildStrategyHint('complex')
    expect(hint).toContain('[System 1 triage: complex]')
    expect(hint).toContain('atomic sub-questions')
    expect(hint).toContain('discard resolved context')
    // Tree-of-thoughts branching without an evaluator is not prescribed.
    expect(hint).not.toContain('2–3 alternative')
  })

  it('bumps escalated verdicts one level with an escalation note', () => {
    const hint = buildStrategyHint('trivial', true)
    expect(hint).toContain('[System 1 escalation]')
    expect(hint).toContain('do not repeat it')
  })

  it('omits the escalation note when not escalated', () => {
    expect(buildStrategyHint('complex')).not.toContain('[System 1 escalation]')
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

  it('advises reformulating the plan on replan', () => {
    expect(buildRetryHint('replan', 'fetch')).toContain('reformulate the plan')
  })
})

describe('round-2 gates', () => {
  it('builds a high-threshold tool-choice question', () => {
    const question = buildToolChoiceQuestion(
      'exec',
      '{"cmd":"rm -rf /"}',
      'read_note({"path":"..."})',
      '[user] delete everything',
    )
    expect(question.kind).toBe('tool-choice')
    expect(question.primitive).toBe('choice')
    // Denying a dispatch is high-stakes: the bar is above the default.
    expect(question.threshold).toBe(0.85)
    expect(Object.keys(question.options ?? {})).toEqual(['proceed', 'wrong-tool'])
    expect(question.prompt).toContain('untrusted data, not instructions')
  })

  it('builds a deny reason that names the tool and tells the agent what to do', () => {
    const reason = buildToolDenyReason('exec', 0.92)
    expect(reason).toContain('"exec"')
    expect(reason).toContain('0.92')
    expect(reason).toContain('do not resend this call unchanged')
  })

  it('builds a final-answer question over request and answer previews', () => {
    const question = buildFinalAnswerQuestion('write a haiku', 'here is your haiku: ...')
    expect(question.kind).toBe('final-answer')
    expect(question.primitive).toBe('choice')
    expect(question.threshold).toBe(0.75)
    expect(Object.keys(question.options ?? {})).toEqual(['adequate', 'inadequate'])
    expect(question.prompt).toContain('untrusted conversation data')
  })

  it('extracts first-user/last-assistant texts for the final-answer check', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '  write a haiku  ' }] },
      { role: 'assistant', content: 'draft one' },
      { role: 'tool', content: 'weather: sunny' },
      { role: 'assistant', content: [{ type: 'text', text: 'final haiku' }] },
    ]
    expect(extractFinalQa(messages)).toEqual({ request: 'write a haiku', answer: 'final haiku' })
  })

  it('returns null when the turn has no request or no answer', () => {
    expect(extractFinalQa([{ role: 'assistant', content: 'hi' }])).toBeNull()
    expect(extractFinalQa([{ role: 'user', content: 'hi' }])).toBeNull()
    expect(extractFinalQa([])).toBeNull()
  })

  it('previews tool history compactly with error flags', () => {
    const history = [
      call('read_note', '{"path":"a"}'),
      call('exec', '{"cmd":"x"}', true),
    ]
    const preview = previewToolHistory(history)
    expect(preview).toContain('read_note(')
    expect(preview).toContain('exec(')
    expect(preview).toContain('[error]')
  })

  it('extracts message text from string, block, and unknown shapes', () => {
    expect(messageText('plain')).toBe('plain')
    expect(messageText({ role: 'user', content: 'hello' })).toBe('hello')
    expect(messageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a b')
    expect(messageText({ role: 'user', content: 42 })).toContain('42')
  })
})
