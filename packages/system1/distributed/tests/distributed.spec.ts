/** Distributed tests. */

import { describe, expect, it } from 'vitest'
import { WorkQueue, CheckpointManager } from '@deepseek-ai/dsh-system1-distributed'

describe('WorkQueue', () => {
  it('enqueues and claims work', () => {
    const queue = new WorkQueue({ now: () => 1000 })
    queue.enqueue('task1', 'fence1', { data: 'x' })
    expect(queue.depth()).toBe(1)

    const item = queue.claim('worker1')
    expect(item?.taskId).toBe('task1')
    expect(item?.fencingToken).toBe('fence1')
    expect(item?.enqueuedAtMs).toBe(1000)
    expect(queue.depth()).toBe(0)
  })

  it('returns null when empty', () => {
    const queue = new WorkQueue()
    expect(queue.claim('w1')).toBeNull()
  })

  it('rejects when queue full', () => {
    const queue = new WorkQueue({ maxSize: 1 })
    queue.enqueue('t1', 'f1', null)
    expect(() => queue.enqueue('t2', 'f2', null)).toThrow(/queue full/)
  })

  it('releases claims', () => {
    const queue = new WorkQueue()
    queue.enqueue('t1', 'f1', null)
    queue.claim('w1')
    // Release should not throw (claim tracking is internal).
    queue.release('t1', 'f1')
  })

  it('rejects release without an active claim', () => {
    const queue = new WorkQueue()
    queue.enqueue('t1', 'f1', null)
    // Release is validated against the claim record, not the pending queue.
    expect(() => queue.release('t1', 'f1')).toThrow(/Fencing token mismatch/)
  })

  it('rejects release with a stale token (R24)', () => {
    const queue = new WorkQueue()
    queue.enqueue('task', '1', null)
    queue.claim('worker-a')
    expect(() => queue.release('task', 'stale')).toThrow(/Fencing token mismatch/)
    queue.release('task', '1')
  })

  it('deduplicates deliveries so two workers cannot claim the same task (R23)', () => {
    const queue = new WorkQueue()
    queue.enqueue('task', '1', { attempt: 1 })
    queue.enqueue('task', '1', { attempt: 2 })
    expect(queue.depth()).toBe(1)
    const first = queue.claim('worker-a')
    expect(first?.taskId).toBe('task')
    expect(queue.claim('worker-b')).toBeNull()
  })

  it('drops a redelivery while the task is actively claimed', () => {
    const queue = new WorkQueue()
    queue.enqueue('task', '1', null)
    queue.claim('worker-a')
    queue.enqueue('task', '1', null) // duplicate delivery: dropped
    expect(queue.claim('worker-b')).toBeNull()
    queue.release('task', '1')
    queue.enqueue('task', '1', null) // released claims accept redelivery
    expect(queue.claim('worker-b')?.taskId).toBe('task')
  })

  it('allows redelivery after claim expiry and rejects the stale token', () => {
    let now = 1_000_000
    const queue = new WorkQueue({ now: () => now, claimTtlMs: 60_000 })
    queue.enqueue('task', 'f1', null)
    queue.claim('worker-a')
    now += 61_000 // claim expired
    queue.enqueue('task', 'f2', null)
    expect(queue.claim('worker-b')?.fencingToken).toBe('f2')
    expect(() => queue.release('task', 'f1')).toThrow(/Fencing token mismatch/)
    queue.release('task', 'f2')
  })

  it('settles claims and validates the token', () => {
    const queue = new WorkQueue()
    queue.enqueue('task', 'f1', null)
    queue.claim('worker-a')
    expect(() => queue.settle('missing', 'f1')).toThrow(/Fencing token mismatch/)
    expect(() => queue.settle('task', 'stale')).toThrow(/Fencing token mismatch/)
    queue.settle('task', 'f1')
    // Settled tasks accept a fresh delivery as a new claim.
    queue.enqueue('task', 'f2', null)
    expect(queue.claim('worker-b')?.fencingToken).toBe('f2')
  })

  it('replaces a pending duplicate without tripping the size bound', () => {
    const queue = new WorkQueue({ maxSize: 1 })
    queue.enqueue('t1', 'f1', { v: 1 })
    queue.enqueue('t1', 'f1', { v: 2 }) // latest delivery wins, still one item
    expect(queue.depth()).toBe(1)
    expect(queue.claim('w1')?.payload).toEqual({ v: 2 })
  })

  it('uses default config', () => {
    const queue = new WorkQueue()
    queue.enqueue('t', 'f', null)
    expect(queue.depth()).toBe(1)
  })
})

describe('CheckpointManager', () => {
  it('saves and loads checkpoints', () => {
    const manager = new CheckpointManager({ now: () => 2000 })
    manager.save('task1', 'fence1', { step: 5 })

    const checkpoint = manager.load('task1')
    expect(checkpoint?.taskId).toBe('task1')
    expect(checkpoint?.fencingToken).toBe('fence1')
    expect(checkpoint?.state).toEqual({ step: 5 })
    expect(checkpoint?.checkpointedAtMs).toBe(2000)
  })

  it('returns null for missing checkpoint', () => {
    const manager = new CheckpointManager()
    expect(manager.load('missing')).toBeNull()
  })

  it('rejects overwrite with stale token', () => {
    const manager = new CheckpointManager()
    manager.save('t1', 'fence1', { a: 1 })
    expect(() => manager.save('t1', 'fence2', { a: 2 })).toThrow(/stale token/)
  })

  it('allows overwrite with same token', () => {
    const manager = new CheckpointManager()
    manager.save('t1', 'f1', { a: 1 })
    manager.save('t1', 'f1', { a: 2 })
    expect(manager.load('t1')?.state).toEqual({ a: 2 })
  })

  it('copies state on save and load so caller mutation cannot corrupt it (R25)', () => {
    const manager = new CheckpointManager()
    const state = { executed: false, nested: { count: 0 } }
    manager.save('task', '1', state)
    state.executed = true
    state.nested.count = 99
    expect(manager.load('task')?.state).toEqual({ executed: false, nested: { count: 0 } })

    const loaded = manager.load('task')
    ;(loaded?.state as { executed: boolean }).executed = true
    expect(manager.load('task')?.state).toEqual({ executed: false, nested: { count: 0 } })
  })

  it('deletes checkpoints', () => {
    const manager = new CheckpointManager()
    manager.save('t1', 'f1', null)
    manager.delete('t1')
    expect(manager.load('t1')).toBeNull()
  })

  it('uses default config', () => {
    const manager = new CheckpointManager()
    manager.save('t', 'f', 'state')
    expect(manager.load('t')).not.toBeNull()
  })
})
