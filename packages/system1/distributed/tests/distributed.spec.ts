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

  it('rejects release with stale token', () => {
    const queue = new WorkQueue()
    queue.enqueue('t1', 'f1', null)
    // Item is still in queue (not claimed), try release with wrong token.
    expect(() => queue.release('t1', 'wrong')).toThrow(/Fencing token mismatch/)
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
