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
 * resolves.
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

/** Default cancellation cause when the caller names none. */
const DEFAULT_CANCEL_CAUSE: AgentCancelCause = { kind: 'parent' }

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
  #currentRun: Promise<void> | undefined
  #wakeLatch = false
  #initiator: Agent | undefined
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
   * @param message - the incoming message.
   * @param target - the next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   * @throws when the coordinator is disposed.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append(target, message)
    if (wakeup) this.wake()
  }

  /**
   * Queue an ordinary follow-up turn and wake the driver.
   * @param message - the follow-up message.
   * @throws when the coordinator is disposed.
   */
  followup(message: UserMessage): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append('next-turn', message)
    this.wake()
  }

  /**
   * Submit steering for the nearest step and wake the driver.
   * @param message - the steering message.
   * @throws when the coordinator is disposed.
   */
  steer(message: UserMessage): void {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    this.inbox.append('next-step', message)
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
   * Clear queued work — unless `keepInbox` — and abort the active turn and
   * any maintenance task.
   * @param cause - why the turn is cancelled.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause = DEFAULT_CANCEL_CAUSE, options?: CancelOptions): void {
    this.#lastCancelCause = cause
    this.#wakeLatch = false
    this.#aborter?.abort()
    this.#maintenanceAborter?.abort()
    if (!options?.keepInbox) this.inbox.clear()
  }

  /**
   * Run one non-turn maintenance task from the true idle phase.
   * @param task - the maintenance work; its rejection is preserved.
   * @returns the task promise.
   * @throws when a driver turn is active or the coordinator is disposed.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error(`System1CoordinatorAgent(${this.id}) is disposed`)
    if (this.#currentRun !== undefined) {
      throw new Error(`System1CoordinatorAgent(${this.id}) cannot run maintenance during an active turn`)
    }
    const aborter = new AbortController()
    this.#maintenanceAborter = aborter
    const pending = task(aborter.signal)
    const clear = (): void => {
      if (this.#maintenanceAborter === aborter) this.#maintenanceAborter = undefined
    }
    pending.then(clear, clear)
    return pending
  }

  /**
   * Resolve when the coordinator returns to idle. Driver failures settle
   * the turn without throwing; inspect {@link lastError} for the cause.
   * @returns resolves once no turn is running.
   */
  async whenIdle(): Promise<void> {
    while (this.#currentRun) await this.#currentRun
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
    await this.whenIdle()
    const disposers = this.#effectDisposers.splice(0).reverse()
    for (const disposeEffect of disposers) await disposeEffect()
    await this.#scope.dispose()
  }

  /**
   * Capture the initiator — defaulting to the coordinator itself when
   * woken outside an agent chain — and start the driver unless one is
   * running. A wake during an active turn sets a latch so the queued
   * follow-up work runs once the turn settles.
   */
  private wake(): void {
    this.#initiator = this.ctx.agents.currentInitiator() ?? this
    this.#wakeLatch = true
    this.#wakeDriver()
  }

  /** Transition status and notify observers through the agent dispatcher. */
  #setStatus(status: AgentStatus): void {
    this.#status = status
    this.#dispatch.emit('agent/status', { status })
  }

  /** Start the driver unless a turn is already running or disposed. */
  #wakeDriver(): void {
    if (this.#disposed || this.#currentRun) return
    this.#wakeLatch = false
    this.#setStatus('running')
    const aborter = new AbortController()
    this.#aborter = aborter
    const initiator = this.#initiator ?? this
    this.#initiator = undefined
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
