/** Unit tests for the DeepSeek fallback bounds: circuit breaker, timeout, and config validation. */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FALLBACK_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_FALLBACK_MAX_STEPS,
  DEFAULT_FALLBACK_TIMEOUT_MS,
  FallbackCircuitBreaker,
  invokeFallbackWithTimeout,
  resolveFallbackBounds,
} from '../src/fallback.ts'

describe('resolveFallbackBounds', () => {
  it('applies documented defaults when no bounds are configured', () => {
    const bounds = resolveFallbackBounds(undefined)
    expect(bounds).toEqual({
      timeoutMs: DEFAULT_FALLBACK_TIMEOUT_MS,
      maxConsecutiveFailures: DEFAULT_FALLBACK_MAX_CONSECUTIVE_FAILURES,
      maxSteps: DEFAULT_FALLBACK_MAX_STEPS,
    })
  })

  it('accepts explicit bounds', () => {
    const bounds = resolveFallbackBounds({
      timeoutMs: 1000,
      maxConsecutiveFailures: 1,
      maxSteps: 2,
    })
    expect(bounds).toEqual({ timeoutMs: 1000, maxConsecutiveFailures: 1, maxSteps: 2 })
  })

  it('rejects a non-positive timeout', () => {
    expect(() => resolveFallbackBounds({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => resolveFallbackBounds({ timeoutMs: -1 })).toThrow(/timeoutMs/)
  })

  it('rejects a negative consecutive-failure threshold', () => {
    expect(() => resolveFallbackBounds({ maxConsecutiveFailures: -1 })).toThrow(
      /maxConsecutiveFailures/,
    )
  })

  it('rejects a non-positive step cap', () => {
    expect(() => resolveFallbackBounds({ maxSteps: 0 })).toThrow(/maxSteps/)
  })
})

describe('FallbackCircuitBreaker', () => {
  it('starts closed with no failures', () => {
    const breaker = new FallbackCircuitBreaker(3)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.failures()).toBe(0)
  })

  it('opens after the configured consecutive failures', () => {
    const breaker = new FallbackCircuitBreaker(2)
    expect(breaker.recordFailure()).toBe(false)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.recordFailure()).toBe(true)
    expect(breaker.isOpen()).toBe(true)
    expect(breaker.failures()).toBe(2)
  })

  it('stays open on further failures without re-reporting the transition', () => {
    const breaker = new FallbackCircuitBreaker(1)
    expect(breaker.recordFailure()).toBe(true)
    expect(breaker.recordFailure()).toBe(false)
    expect(breaker.isOpen()).toBe(true)
  })

  it('closes on success and reports the open-to-closed transition once', () => {
    const breaker = new FallbackCircuitBreaker(1)
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(true)
    expect(breaker.recordSuccess()).toBe(true)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.failures()).toBe(0)
    expect(breaker.recordSuccess()).toBe(false)
  })

  it('resets the failure count on success while closed', () => {
    const breaker = new FallbackCircuitBreaker(3)
    breaker.recordFailure()
    expect(breaker.recordSuccess()).toBe(false)
    expect(breaker.failures()).toBe(0)
    expect(breaker.isOpen()).toBe(false)
  })
})

describe('invokeFallbackWithTimeout', () => {
  it('returns the handler result when it settles in time', async () => {
    const controller = new AbortController()
    const result = await invokeFallbackWithTimeout(
      async (signal) => {
        expect(signal.aborted).toBe(false)
        return 'done'
      },
      controller.signal,
      1000,
    )
    expect(result).toBe('done')
  })

  it('aborts the handler and returns timeout when the budget expires', async () => {
    const controller = new AbortController()
    let seenAborted = false
    const result = await invokeFallbackWithTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          const onAbort = (): void => {
            seenAborted = true
            resolve('late')
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      controller.signal,
      10,
    )
    expect(result).toBe('timeout')
    expect(seenAborted).toBe(true)
  })

  it('propagates a handler rejection without a timeout', async () => {
    const controller = new AbortController()
    await expect(
      invokeFallbackWithTimeout(
        async () => {
          throw new Error('handler down')
        },
        controller.signal,
        1000,
      ),
    ).rejects.toThrow('handler down')
  })

  it('aborts promptly when the parent signal fires first', async () => {
    const controller = new AbortController()
    let seenAborted = false
    const pending = invokeFallbackWithTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              seenAborted = true
              resolve('cancelled')
            },
            { once: true },
          )
        }),
      controller.signal,
      1000,
    )
    controller.abort()
    // The handler resolves on abort; the timeout never fires.
    await expect(pending).resolves.toBe('cancelled')
    expect(seenAborted).toBe(true)
  })

  it('treats an already-aborted parent as an immediate abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await invokeFallbackWithTimeout(
      (signal) => Promise.resolve(signal.aborted ? 'aborted' : 'ran'),
      controller.signal,
      1000,
    )
    expect(result).toBe('aborted')
  })
})
