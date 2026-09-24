/**
 * Coverage for the async-actuation primitives the composition suites leave
 * unexercised: {@link JudgmentBoard} settlement queries, zero-deadline and
 * pre-aborted takes, rejection takes, capacity eviction, and the
 * {@link policy.ts} ledger eviction loops plus the verdict-escalation
 * ternary. Product code is unchanged; these are pure unit tests.
 */

import { describe, expect, it } from 'vitest'
import { JudgmentBoard } from '../src/board.ts'
import {
  compileToolPatterns,
  escalateVerdict,
  HintLedger,
  isFreshStep,
  isRiskyTool,
  isUpgrade,
  PendingQueue,
  RouteLedger,
} from '../src/policy.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// JudgmentBoard: settlement queries
// ---------------------------------------------------------------------------

describe('JudgmentBoard settlement queries', () => {
  it('isSettled is false for a pending slot, true once settled, false when missing', async () => {
    const board = new JudgmentBoard()
    expect(board.isSettled('missing')).toBe(false)
    let release: (value: string) => void = () => {}
    board.post('k', new Promise<string>((resolve) => { release = resolve }))
    expect(board.isSettled('k')).toBe(false)
    release('v')
    await sleep(0)
    expect(board.isSettled('k')).toBe(true)
    board.delete('k')
    expect(board.isSettled('k')).toBe(false)
  })

  it('ageMs reports a non-negative age for a posted slot, null when missing', async () => {
    const board = new JudgmentBoard()
    expect(board.ageMs('missing')).toBeNull()
    board.post('k', Promise.resolve('v'))
    const age = board.ageMs('k')
    expect(age).not.toBeNull()
    expect(age ?? Number.NaN).toBeGreaterThanOrEqual(0)
    await sleep(2)
    expect(board.ageMs('k') ?? Number.NaN).toBeGreaterThanOrEqual(age ?? Number.NaN)
  })
})

// ---------------------------------------------------------------------------
// JudgmentBoard: take deadlines
// ---------------------------------------------------------------------------

describe('JudgmentBoard take deadlines', () => {
  it('a non-positive deadline returns late without waiting', async () => {
    const board = new JudgmentBoard()
    board.post('k', new Promise<string>(() => {}))
    const started = Date.now()
    expect(await board.take('k', 0)).toEqual({ status: 'late' })
    expect(await board.take('k', -10)).toEqual({ status: 'late' })
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('an already-aborted signal returns late without waiting', async () => {
    const board = new JudgmentBoard()
    board.post('k', new Promise<string>(() => {}))
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    expect(await board.take('k', 1000, controller.signal)).toEqual({ status: 'late' })
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('take on an already-settled slot returns ready without waiting', async () => {
    const board = new JudgmentBoard()
    board.post('k', Promise.resolve('v'))
    await sleep(0)
    const started = Date.now()
    expect(await board.take('k', 1000)).toEqual({ status: 'ready', value: 'v' })
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('a rejected judgment resolves take as ready with a null value', async () => {
    const board = new JudgmentBoard()
    board.post('bad', Promise.reject(new Error('boom')))
    expect(await board.take('bad', 1000)).toEqual({ status: 'ready', value: null })
    expect(board.isSettled('bad')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// JudgmentBoard: capacity
// ---------------------------------------------------------------------------

describe('JudgmentBoard capacity', () => {
  it('evicts the oldest slot past capacity', () => {
    const board = new JudgmentBoard(2)
    board.post('a', Promise.resolve('a'))
    board.post('b', Promise.resolve('b'))
    board.post('c', Promise.resolve('c'))
    expect(board.size).toBe(2)
    expect(board.has('a')).toBe(false)
    expect(board.has('b')).toBe(true)
    expect(board.has('c')).toBe(true)
  })

  it('clear() with no prefix removes every slot', () => {
    const board = new JudgmentBoard()
    board.post('a', Promise.resolve('a'))
    board.post('b', Promise.resolve('b'))
    board.clear()
    expect(board.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// policy: verdict helpers
// ---------------------------------------------------------------------------

describe('verdict helpers', () => {
  it('escalateVerdict moves one level up; complex stays complex', () => {
    expect(escalateVerdict('trivial')).toBe('standard')
    expect(escalateVerdict('standard')).toBe('complex')
    expect(escalateVerdict('complex')).toBe('complex')
  })

  it('isUpgrade is true only for strictly more demanding verdicts', () => {
    expect(isUpgrade('trivial', 'standard')).toBe(true)
    expect(isUpgrade('trivial', 'complex')).toBe(true)
    expect(isUpgrade('standard', 'complex')).toBe(true)
    expect(isUpgrade('trivial', 'trivial')).toBe(false)
    expect(isUpgrade('standard', 'trivial')).toBe(false)
    expect(isUpgrade('complex', 'standard')).toBe(false)
    expect(isUpgrade('complex', 'complex')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// policy: RouteLedger
// ---------------------------------------------------------------------------

describe('RouteLedger bounds', () => {
  it('evicts the oldest agent entry past capacity', () => {
    const ledger = new RouteLedger(1)
    ledger.offer('a1', 1, 'trivial', null)
    ledger.offer('a2', 1, 'standard', null)
    expect(ledger.get('a1', 1)).toBeNull()
    expect(ledger.get('a2', 1)).toEqual({ verdict: 'standard', traceId: null })
  })

  it('get returns null on a turn mismatch', () => {
    const ledger = new RouteLedger()
    ledger.offer('a1', 1, 'trivial', 't1')
    expect(ledger.get('a1', 2)).toBeNull()
    expect(ledger.get('nobody', 1)).toBeNull()
  })

  it('escalate returns null for missing entries and non-escalating verdicts', () => {
    const ledger = new RouteLedger()
    expect(ledger.escalate('nobody', 1)).toBeNull()
    ledger.offer('a1', 1, 'complex', null)
    expect(ledger.escalate('a1', 1)).toBeNull()
    ledger.offer('a2', 1, 'trivial', null)
    expect(ledger.escalate('a2', 1)).toBe('standard')
    expect(ledger.escalate('a2', 9)).toBeNull()
  })

  it('reset forgets the agent', () => {
    const ledger = new RouteLedger()
    ledger.offer('a1', 1, 'trivial', null)
    ledger.reset('a1')
    expect(ledger.get('a1', 1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// policy: HintLedger
// ---------------------------------------------------------------------------

describe('HintLedger bounds', () => {
  it('evicts the oldest agent entry past capacity', () => {
    const ledger = new HintLedger(1)
    expect(ledger.admit('a1', 1, 'h')).toBe(true)
    expect(ledger.admit('a2', 1, 'h')).toBe(true)
    // a1 was evicted, so its hint admits again instead of deduping.
    expect(ledger.admit('a1', 1, 'h')).toBe(true)
  })

  it('dedupes within a turn, admits again on a new turn, resets on demand', () => {
    const ledger = new HintLedger()
    expect(ledger.admit('a1', 1, 'h')).toBe(true)
    expect(ledger.admit('a1', 1, 'h')).toBe(false)
    expect(ledger.admit('a1', 2, 'h')).toBe(true)
    ledger.reset('a1')
    expect(ledger.admit('a1', 2, 'h')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// policy: PendingQueue
// ---------------------------------------------------------------------------

describe('PendingQueue bounds', () => {
  it('evicts the oldest agent queue past capacity', () => {
    const queue = new PendingQueue(32, 1)
    queue.push('a1', 'k1')
    queue.push('a2', 'k2')
    expect(queue.list('a1')).toEqual([])
    expect(queue.list('a2')).toEqual(['k2'])
  })

  it('drops the oldest keys past maxPerAgent', () => {
    const queue = new PendingQueue(2)
    queue.push('a1', 'k1')
    queue.push('a1', 'k2')
    queue.push('a1', 'k3')
    expect(queue.list('a1')).toEqual(['k2', 'k3'])
  })

  it('retain keeps only the listed keys; an empty retain clears the queue', () => {
    const queue = new PendingQueue()
    queue.push('a1', 'k1')
    queue.push('a1', 'k2')
    queue.retain('a1', ['k2'])
    expect(queue.list('a1')).toEqual(['k2'])
    queue.retain('a1', [])
    expect(queue.list('a1')).toEqual([])
  })

  it('reset forgets the agent', () => {
    const queue = new PendingQueue()
    queue.push('a1', 'k1')
    queue.reset('a1')
    expect(queue.list('a1')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// policy: tool patterns and step freshness
// ---------------------------------------------------------------------------

describe('tool patterns and step freshness', () => {
  it('compileToolPatterns skips invalid patterns without throwing', () => {
    const compiled = compileToolPatterns(['^bash', '([invalid'])
    expect(compiled).toHaveLength(1)
    expect(isRiskyTool('bash', compiled)).toBe(true)
    expect(isRiskyTool('inspect', compiled)).toBe(false)
  })

  it('isFreshStep flags first steps and steered steps only', () => {
    expect(isFreshStep(1, 0)).toBe(true)
    expect(isFreshStep(2, 3)).toBe(true)
    expect(isFreshStep(3, 0)).toBe(false)
  })
})
