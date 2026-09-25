/**
 * The System 1 coordinator agent: a custom AgentRegistry runtime root.
 *
 * The coordinator owns a private Cordis scope minted with itself as the
 * scope key, exactly like the standard agent loop roots agents in their
 * own scope: tool registrations and listeners made through
 * `coordinator.ctx` are invisible to other coordinators and to ordinary
 * DeepSeek workers, and they disappear when the coordinator is disposed.
 * Lifecycle events such as `agent/status` dispatch through the plugin
 * context so they stay observable app-wide.
 *
 * Teardown is owned explicitly. Tracked effects unwind in reverse
 * registration order, then the owned scope is disposed to remove any
 * direct registrations. Disposal is memoized: simultaneous callers share
 * one teardown, and asynchronous disposers are awaited before dispose
 * resolves. Driver turns, maintenance tasks, and delegated work are owned
 * activities of one lifecycle: cancellation aborts all of them, wakes
 * queue behind maintenance, and disposal drains everything.
 */
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentEventDispatch,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { System1Inbox } from './inbox.ts'
import type { System1InboxData, System1VerificationData } from './events.ts'
import type { LeaseAuthority, System1RequestId } from './types.ts'

/** Default cancellation cause when the caller names none. */
const DEFAULT_CANCEL_CAUSE: AgentCancelCause = { kind: 'parent' }

/** Maximum delegation depth; deeper nesting is refused fail-closed. */
const MAX_DELEGATION_DEPTH = 5

/**
 * One unit of coordinator work. The contract is stable: run to completion
 * and honor the abort signal.
 */
export interface CoordinatorDriver {
  /**
   * Run the coordinator's current turn.
   * @param coordinator - the coordinator being driven.
   * @param signal - aborts when the coordinator is cancelled or disposed.
   * @returns resolves when the turn settles; rejects on abort.
   */
  run(coordinator: System1CoordinatorAgent, signal: AbortSignal): Promise<void>
}

/**
 * A custom runtime root registered with {@link AgentRegistry} via
 * `register()`. Never replaces the DeepSeek factory.
 */
export class System1CoordinatorAgent implements Agent {
  /** The live agent/session identity. */
  readonly id: SessionId
  /** Coordinator options; empty until a phase defines runtime options. */
  readonly options: Readonly<Record<string, unknown>> = {}
  /** The durable write-ahead log backing this coordinator. */
  readonly session: Session
  /** Turn/step work queues. */
  readonly inbox: System1Inbox
  /**
   * The coordinator-owned Cordis scope. Registrations made through it are
   * private to this coordinator; the scope is disposed with the
   * coordinator. Lifecycle dispatch stays on the plugin context so
   * `agent/*` events remain app-visible.
   */
  readonly ctx: Context

  #scope: Scope
  #status: AgentStatus = 'idle'
  #driver: CoordinatorDriver
  #dispatch: AgentEventDispatch
  #aborter: AbortController | undefined
  #maintenanceAborter: AbortController | undefined
  /**
   * The active maintenance task, when one owns the lifecycle. Wakes queue
   * behind it; disposal drains it.
   */
  #maintenanceRun: Promise<unknown> | undefined
  /** In-flight delegated work; cancelled with the coordinator and drained on dispose. */
  #delegatedActivities = new Set<Promise<void>>()
  /** Abort controllers for delegated work, so parent cancellation reaches it. */
  #delegatedAborters = new Set<AbortController>()
  #currentRun: Promise<void> | undefined
  #wakeLatch = false
  /**
   * The agent whose context issued the current wake, kept separately from
   * the initiator the coordinator establishes for its own turn.
   */
  #causalInitiator: Agent | undefined
  /** Optional live-lease check consulted by {@link delegate}. */
  #leaseAuthority: LeaseAuthority | undefined
  #lastError: unknown
  #lastCancelCause: AgentCancelCause | undefined
  #effectDisposers: Array<() => void | Promise<void>> = []
  #disposed = false
  #disposePromise: Promise<void> | undefined

  /**
   * @param ctx - the plugin context this coordinator is rooted in.
   * @param session - the durable session backing this coordinator.
   * @param driver - the unit of work each turn runs.
   */
  constructor(ctx: Context, session: Session, driver: CoordinatorDriver) {
    this.#scope = createScope(ctx, this)
    this.ctx = this.#scope.ctx
    this.id = session.id
    this.session = session
    this.inbox = new System1Inbox()
    this.#driver = driver
    this.#dispatch = agentEvents(ctx, this)
  }

  /** The coordinator's lifecycle state. */
  get status(): AgentStatus {
    return this.#status
  }

  /**
   * The last non-abort driver failure, if any. Abort rejections settle
   * the turn silently; unexpected failures are recorded here instead of
   * vanishing into an unhandled rejection.
   */
  get lastError(): unknown {
    return this.#lastError
  }

  /** The cause of the most recent {@link cancel}, if any. */
  get lastCancelCause(): AgentCancelCause | undefined {
    return this.#lastCancelCause
  }

  /**
   * Register a Cordis effect owned by this coordinator. The disposer is
   * tracked and unwound by {@link dispose} in reverse registration order;
   * asynchronous disposers are awaited there.
   * @param args - the exact arguments `ctx.effect` accepts.
   * @returns a disposer that untracks and invokes the effect disposer.
   */
  effect(...args: Parameters<Context['effect']>): () => void {
    const disposer = Reflect.apply(this.ctx.effect, this.ctx, args) as () => void | Promise<void>
    let untracked = false
    const untrack = (): void => {
      if (untracked) return
      untracked = true
      const index = this.#effectDisposers.indexOf(disposer)
      if (index >= 0) this.#effectDisposers.splice(index, 1)
    }
    this.#effectDisposers.push(disposer)
    return () => {
      untrack()
      void disposer()
    }
  }

  /**
   * Route input to an inbox boundary and optionally wake the driver.
   * The append is also written to the durable session log as a
   * `system1/inbox` event, so a restarted coordinator can rebuild its
   * pending work via {@link recover}.
   * @param message - the incoming message.
   * @param target - the next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   * @throws when the coordinator is disposed.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append(target, message)
    this.session.append('system1/inbox', {
      schemaVersion: 1,
      target,
      message,
      appendedAt: Date.now(),
    } satisfies System1InboxData)
    if (wakeup) this.wake()
  }

  /**
   * Queue an ordinary follow-up turn and wake the driver. The append is
   * durable (see {@link send}).
   * @param message - the follow-up message.
   * @throws when the coordinator is disposed.
   */
  followup(message: UserMessage): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append('next-turn', message)
    this.session.append('system1/inbox', {
      schemaVersion: 1,
      target: 'next-turn',
      message,
      appendedAt: Date.now(),
    } satisfies System1InboxData)
    this.wake()
  }

  /**
   * Submit steering for the nearest step and wake the driver. The append
   * is durable (see {@link send}).
   * @param message - the steering message.
   * @throws when the coordinator is disposed.
   */
  steer(message: UserMessage): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append('next-step', message)
    this.session.append('system1/inbox', {
      schemaVersion: 1,
      target: 'next-step',
      message,
      appendedAt: Date.now(),
    } satisfies System1InboxData)
    this.wake()
  }

  /**
   * Queue model-facing context for the next step without waking the driver.
   * @param message - the context message.
   * @throws when the coordinator is disposed.
   */
  inject(message: UserMessage): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append('next-step', message)
  }

  /**
   * Rebuild the in-memory inbox by replaying durable `system1/inbox`
   * events from the session log. Clears the current inbox first, so it
   * is safe to call on a fresh coordinator sharing the session after a
   * restart. Messages replay in log order per boundary.
   * @throws when the coordinator is disposed.
   */
  recover(): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.clear()
    for (const event of this.session.snapshotEvents()) {
      if (event.type === 'system1/inbox') {
        this.inbox.append(event.data.target, event.data.message)
      }
    }
  }

  /**
   * Delegate a unit of work with fencing and depth enforcement. The work
   * runs as an owned activity of the coordinator: parent cancellation
   * aborts it, and disposal drains it. When a lease authority is bound via
   * {@link bindLeaseAuthority} the fencing token is checked against the
   * live lease and a stale token is refused; without a bound authority only
   * the token format is checked. Delegation deeper than
   * {@link MAX_DELEGATION_DEPTH} fails closed.
   * @param fencingToken - positive integer fencing token from the
   * coordinator's lease.
   * @param depth - current delegation depth; 0 for direct coordinator work.
   * @param work - the delegated work; receives an abort signal and the
   * fencing token.
   * @returns resolves when the delegated work completes.
   * @throws when the coordinator is disposed, the token is invalid or
   * stale, or depth exceeds the maximum.
   */
  async delegate(
    fencingToken: number,
    depth: number,
    work: (signal: AbortSignal, fencingToken: number) => Promise<void>,
  ): Promise<void> {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    if (!Number.isInteger(fencingToken) || fencingToken <= 0) {
      throw new Error(
        `System1CoordinatorAgent(${this.id}) refuses delegation with invalid fencing token`,
      )
    }
    this.#leaseAuthority?.checkFencingToken(fencingToken)
    if (depth >= MAX_DELEGATION_DEPTH) {
      throw new Error(
        `System1CoordinatorAgent(${this.id}) refuses delegation at depth ${depth} (max ${MAX_DELEGATION_DEPTH})`,
      )
    }
    const aborter = new AbortController()
    this.#delegatedAborters.add(aborter)
    let activity!: Promise<void>
    activity = (async (): Promise<void> => {
      try {
        await work(aborter.signal, fencingToken)
      } finally {
        this.#delegatedAborters.delete(aborter)
        this.#delegatedActivities.delete(activity)
      }
    })()
    this.#delegatedActivities.add(activity)
    await activity
  }

  /**
   * Bind the lease authority consulted by {@link delegate}. A bound
   * authority lets delegation reject stale fencing tokens against the live
   * lease instead of trusting the token format alone. Pass `undefined` to
   * unbind.
   * @param authority - the lease authority, or `undefined` to unbind.
   * @throws when the coordinator is disposed.
   */
  bindLeaseAuthority(authority: LeaseAuthority | undefined): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.#leaseAuthority = authority
  }

  /**
   * Retrieve durable verification evidence for a workflow request, in
   * session-log order. Evidence is written as `system1/verification`
   * events; this reads them back for audit or recovery.
   * @param requestId - the workflow request to query.
   * @returns the verification records logged for the request.
   */
  getEvidence(requestId: System1RequestId): System1VerificationData[] {
    const evidence: System1VerificationData[] = []
    for (const event of this.session.snapshotEvents()) {
      if (event.type === 'system1/verification' && event.data.requestId === requestId) {
        evidence.push(event.data)
      }
    }
    return evidence
  }

  /**
   * Clear queued work — unless `keepInbox` — and abort the active turn,
   * any maintenance task, and all delegated work.
   * @param cause - why the turn is cancelled.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause = DEFAULT_CANCEL_CAUSE, options?: CancelOptions): void {
    this.#lastCancelCause = cause
    this.#wakeLatch = false
    this.#aborter?.abort()
    this.#maintenanceAborter?.abort()
    for (const aborter of this.#delegatedAborters) aborter.abort()
    if (!options?.keepInbox) this.inbox.clear()
  }

  /**
   * Run one non-turn maintenance task from the true idle phase. The task
   * is an owned activity of the coordinator: cancellation aborts it,
   * disposal drains it, wakes queue behind it, and overlapping maintenance
   * is rejected.
   * @param task - the maintenance work; its rejection is preserved.
   * @returns the task promise.
   * @throws when a driver turn or another maintenance task is active, or
   * the coordinator is disposed.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    if (this.#currentRun !== undefined) {
      throw new Error(`System1CoordinatorAgent(${this.id}) cannot run maintenance during an active turn`)
    }
    if (this.#maintenanceRun !== undefined) {
      throw new Error(
        `System1CoordinatorAgent(${this.id}) cannot run maintenance while another maintenance task is active`,
      )
    }
    const aborter = new AbortController()
    this.#maintenanceAborter = aborter
    const tracked = task(aborter.signal).then(
      (value) => {
        this.#settleMaintenance(aborter)
        return value
      },
      (error: unknown) => {
        this.#settleMaintenance(aborter)
        throw error
      },
    )
    this.#maintenanceRun = tracked
    return tracked
  }

  /**
   * Release maintenance ownership and start a latched wake, if any, now
   * that the lifecycle is free.
   */
  #settleMaintenance(aborter: AbortController): void {
    if (this.#maintenanceAborter === aborter) this.#maintenanceAborter = undefined
    this.#maintenanceRun = undefined
    if (this.#wakeLatch && !this.#disposed) this.#wakeDriver()
  }

  /**
   * Resolve when the coordinator returns to idle. Every owned activity —
   * the driver turn, a maintenance task, and delegated work — must settle.
   * Driver failures settle the turn without throwing; inspect
   * {@link lastError} for the cause.
   * @returns resolves once no owned activity is running.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      const activities: Array<Promise<unknown>> = []
      if (this.#currentRun !== undefined) activities.push(this.#currentRun)
      if (this.#maintenanceRun !== undefined) activities.push(this.#maintenanceRun)
      for (const activity of this.#delegatedActivities) activities.push(activity)
      if (activities.length === 0) return
      await Promise.allSettled(activities)
    }
  }

  /**
   * Release coordinator-owned resources in dependency order: stop
   * accepting work, cancel and drain the driver and maintenance, unwind
   * owned effects in reverse order (awaiting asynchronous disposers),
   * then dispose the owned scope. Simultaneous callers share one
   * teardown. Registry removal stays with the plugin handle, mirroring
   * the factory's `AgentHandle` split.
   * @returns resolves once the driver settled and effects unwound.
   */
  async dispose(): Promise<void> {
    return (this.#disposePromise ??= this.#doDispose())
  }

  /** One-shot teardown behind the memoized {@link dispose}. */
  async #doDispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#wakeLatch = false
    this.#aborter?.abort()
    this.#maintenanceAborter?.abort()
    for (const aborter of this.#delegatedAborters) aborter.abort()
    // Drain every owned activity — driver, maintenance, delegated work —
    // before unwinding effects, so disposal never resolves while owned
    // work is still running.
    await this.whenIdle()
    const disposers = this.#effectDisposers.splice(0).reverse()
    for (const disposeEffect of disposers) await disposeEffect()
    await this.#scope.dispose()
  }

  /**
   * Capture the causal waker — the agent whose context issued the wake,
   * if any — and start the driver unless a turn is running or maintenance
   * owns the lifecycle. A wake during an active turn or maintenance sets a
   * latch so the queued follow-up work runs once the owner settles.
   */
  private wake(): void {
    this.#causalInitiator = this.ctx.agents.currentInitiator()
    this.#wakeLatch = true
    this.#wakeDriver()
  }

  /** Transition status and notify observers through the agent dispatcher. */
  #setStatus(status: AgentStatus): void {
    this.#status = status
    this.#dispatch.emit('agent/status', { status })
  }

  /** Start the driver unless a turn is running, maintenance is active, or disposed. */
  #wakeDriver(): void {
    if (this.#disposed || this.#currentRun || this.#maintenanceRun) return
    this.#wakeLatch = false
    this.#setStatus('running')
    const aborter = new AbortController()
    this.#aborter = aborter
    // The executing coordinator owns its orchestration chain: like the
    // ordinary agent loop, it establishes itself as the initiator. A wake
    // issued from another coordinator therefore re-roots the chain here,
    // while a non-coordinator initiator is preserved; the causal waker is
    // kept separately for the turn instead of being attributed the work.
    const causal = this.#causalInitiator
    this.#causalInitiator = undefined
    const initiator = causal instanceof System1CoordinatorAgent ? this : (causal ?? this)
    const run = (async (): Promise<void> => {
      try {
        await this.ctx.agents.withInitiator(initiator, () => this.#driver.run(this, aborter.signal))
      } catch (error) {
        if (!aborter.signal.aborted) {
          this.#lastError = error
        }
      } finally {
        // A new turn cannot start while #currentRun is set, so #aborter is
        // still ours here; clear it unconditionally.
        this.#aborter = undefined
        this.#currentRun = undefined
        if (this.#wakeLatch && !this.#disposed) {
          this.#wakeDriver()
        } else {
          this.#setStatus('idle')
        }
      }
    })()
    // Settle, never throw: whenIdle observes completion, lastError the cause.
    // The driver turn is fully contained above and agent notifications are
    // non-vetoing, so this promise cannot reject.
    this.#currentRun = run.then(() => undefined)
  }
}
