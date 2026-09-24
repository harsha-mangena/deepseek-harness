/**
 * Unit tests for the telemetry atom (src/telemetry.ts): every trace —
 * including shadow and fallback — lands a durable `system1/decision`
 * event, and actuations land a separate `system1/decision-acted` event
 * keyed by trace id. Appends never throw.
 */
import { describe, expect, it } from 'vitest'
import { appendDecisionActedEvent, appendDecisionEvent } from '../src/telemetry.ts'
import type { TelemetrySession } from '../src/telemetry.ts'
import type { System1Trace } from '../src/types.ts'

interface AppendedEvent {
  type: string
  data: Record<string, unknown>
  opts?: { ignorable?: true } | undefined
}

function mockSession(events: AppendedEvent[], throws = false): TelemetrySession {
  return {
    append(type: string, data: Record<string, unknown>, opts?: { ignorable?: true }) {
      if (throws) throw new Error('session closed')
      events.push({ type, data, opts })
      return { seq: events.length }
    },
  }
}

function trace(overrides: Partial<System1Trace> = {}): System1Trace {
  return {
    id: 'trace-1',
    at: 1700000000000,
    agentId: 'agent-1',
    questionKind: 'tool-choice',
    mode: 'enforce',
    backend: 'jev',
    confidence: 0.9,
    latencyMs: 150,
    fallback: null,
    acted: false,
    ...overrides,
  }
}

describe('appendDecisionEvent', () => {
  it('logs every trace, including non-acted shadow traces', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events)
    expect(appendDecisionEvent(session, trace({ acted: false }))).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('system1/decision')
    expect(events[0]?.data.traceId).toBe('trace-1')
    expect(events[0]?.data.acted).toBe(false)
  })

  it('marks the decision event ignorable so foreign builds can read the log', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events)
    appendDecisionEvent(session, trace())
    expect(events[0]?.opts).toEqual({ ignorable: true })
  })

  it('records fallbacks and models when present', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events)
    appendDecisionEvent(session, trace({ fallback: 'backend-error', model: 'jev-1.13.0', acted: true }))
    expect(events[0]?.data.fallback).toBe('backend-error')
    expect(events[0]?.data.model).toBe('jev-1.13.0')
    expect(events[0]?.data.acted).toBe(true)
  })

  it('returns false instead of throwing on a closed session', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events, true)
    expect(appendDecisionEvent(session, trace())).toBe(false)
    expect(events).toHaveLength(0)
  })
})

describe('appendDecisionActedEvent', () => {
  it('logs an actuation keyed by trace id', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events)
    expect(appendDecisionActedEvent(session, 'trace-1')).toBe(true)
    expect(events[0]?.type).toBe('system1/decision-acted')
    expect(events[0]?.data.traceId).toBe('trace-1')
    expect(typeof events[0]?.data.at).toBe('number')
  })

  it('marks the decision-acted event ignorable so foreign builds can read the log', () => {
    const events: AppendedEvent[] = []
    const session = mockSession(events)
    appendDecisionActedEvent(session, 'trace-1')
    expect(events[0]?.opts).toEqual({ ignorable: true })
  })

  it('returns false instead of throwing on a closed session', () => {
    const events: AppendedEvent[] = []
    expect(appendDecisionActedEvent(mockSession(events, true), 'trace-1')).toBe(false)
  })
})
