/**
 * System 1 workflow plugin: kill-switched coordinator creation.
 *
 * The plugin never replaces the DeepSeek agent factory. It registers
 * already-constructed {@link System1CoordinatorAgent} instances as custom
 * runtime roots through `AgentRegistry.register()`, so the standard
 * DeepSeek path and the System 1 path share one registry and one session
 * event log. While `mode` is `off` the plugin is inert: coordinator creation
 * is refused and the standard path is untouched.
 *
 * The service class is declared in the entry file, mirroring repository
 * service plugins: the Cordis Loader resolves the default export as the
 * plugin, and the config catalog generator classifies the entry the same
 * way.
 *
 * @module @deepseek-ai/dsh-system1-workflow
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { System1CoordinatorAgent } from './coordinator-agent.ts'
import type { CoordinatorDriver } from './coordinator-agent.ts'
import type {
  ResolvedSystem1WorkflowConfig,
  System1CoordinatorHandle,
  System1WorkflowConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    system1Workflows: System1Workflows
  }
}

/** System 1 workflow plugin: creates and owns coordinator agents. */
export class System1Workflows extends Service {
  // Coordinator creation needs the registry; injection orders startup after
  // it. The coordinator owns a private Cordis scope, and scoped tool
  // registrations must resolve through it, so the tool runtime is a
  // required dependency too.
  static inject = ['agents', 'tools']

  static Config: z<System1WorkflowConfig> = z.object({
    mode: z.union(['off', 'shadow', 'enforce']).default('off'),
    provider: z.union(['jev']).default('jev'),
    // Schemastery 3.x object fields are optional by default; absent model
    // lets Jev resolve its pinned default at call time.
    model: z.string(),
  })

  /** Resolved plugin configuration. Fixed at boot, except `mode`, which
   * {@link rollbackToBaseline} transitions one-way to `'off'`. */
  readonly config: ResolvedSystem1WorkflowConfig

  /**
   * Dispose callbacks for live coordinators. Pending creations are
   * tracked here too, before their registration settles, so a rollback
   * that starts mid-registration still drains the coordinator once it
   * settles. The plugin fiber runs them on unload (HMR reload or shutdown)
   * so every AgentRegistry registration is removed and a reloaded plugin
   * starts clean.
   */
  private readonly liveCoordinators = new Set<() => Promise<void>>()

  /**
   * Creation barrier latched synchronously when a rollback starts, before
   * any drain await. While latched, {@link create} is refused even though
   * the mode is not yet `'off'`, so no coordinator can slip in between the
   * drain snapshot and the mode latch.
   */
  private draining = false

  /**
   * Memoized rollback drain: simultaneous {@link rollbackToBaseline}
   * callers share one drain instead of racing two.
   */
  private rollbackPromise: Promise<void> | undefined

  constructor(ctx: Context, config: System1WorkflowConfig = {}) {
    super(ctx, 'system1Workflows')
    this.config = {
      mode: config.mode ?? 'off',
      provider: config.provider ?? 'jev',
      model: config.model,
    }
    this.ctx.effect(() => async () => {
      const pending = [...this.liveCoordinators]
      this.liveCoordinators.clear()
      await Promise.allSettled(pending.map(dispose => dispose()))
    }, 'system1:dispose-coordinators')
  }

  /**
   * Create a coordinator for a session and register it as a custom runtime
   * root. The standard DeepSeek factory is never touched. The returned
   * handle is only handed out after `agent/created` has been delivered, so a
   * veto or collision rejects here and leaves no residue.
   * @param session - session the coordinator drives; the coordinator id must
   *   equal the session id.
   * @param driver - driver the coordinator wakes; it runs one turn per wake.
   * @returns the coordinator and its owned teardown handle.
   * @throws when the plugin mode is `off`, when a rollback drain is in
   *   flight, when the session already has a registered agent, or when an
   *   `agent/created` listener vetoes.
   */
  async create(
    session: Session,
    driver: CoordinatorDriver,
  ): Promise<System1CoordinatorHandle> {
    if (this.config.mode === 'off') {
      throw new Error('system1: coordinator creation refused while mode is "off"')
    }
    if (this.draining) {
      throw new Error('system1: coordinator creation refused while rollback is draining')
    }
    const coordinator = new System1CoordinatorAgent(this.ctx, session, driver)
    const unregister = this.ctx.agents.register(coordinator)
    // Gate that settles once registration finished, successfully or not.
    let settleRegistration!: () => void
    const registrationGate = new Promise<void>((resolve) => {
      settleRegistration = resolve
    })
    let registered = false
    // One teardown per handle: concurrent callers share it instead of each
    // marking disposed and racing the cleanup.
    let teardown: Promise<void> | undefined
    const dispose = (): Promise<void> =>
      (teardown ??= (async (): Promise<void> => {
        this.liveCoordinators.delete(dispose)
        // A creation still suspended on registration is drained once the
        // registration settles, so rollback never leaves a half-created
        // coordinator running.
        await registrationGate
        await coordinator.dispose()
        if (registered) await unregister()
      })())
    // Track pending creations as well as live agents: a rollback that
    // starts while registration is in flight drains this handle.
    this.liveCoordinators.add(dispose)
    // Awaiting the disposer settles the registration effect (enter plus the
    // serial agent/created announcement) without disposing it, so creation
    // failures reject here instead of surfacing as unhandled rejections.
    try {
      await unregister
      registered = true
    } catch (error) {
      settleRegistration()
      await dispose()
      throw error
    }
    settleRegistration()
    return { coordinator, dispose }
  }

  /**
   * Look up a live coordinator by session id.
   * @param sessionId - session identity to look up.
   * @returns the coordinator, or `undefined` when no coordinator is
   *   registered for the session.
   */
  get(sessionId: SessionId): System1CoordinatorAgent | undefined {
    const agent = this.ctx.agents.get(sessionId)
    return agent instanceof System1CoordinatorAgent ? agent : undefined
  }

  /**
   * Roll the integration back to the baseline DeepSeek path. Every live
   * coordinator is drained and unregistered — in-flight turns are
   * cancelled, the driver settles, and owned effects unwind — using the
   * same teardown as {@link System1CoordinatorHandle.dispose}. Nothing is
   * deleted: inbox appends, receipts, verification evidence, unknown
   * outcomes, and terminal records all stay in the durable session log,
   * and budget and fencing state are untouched. Afterwards the plugin
   * mode is latched to `'off'`, so coordinator creation is refused and
   * new work takes the standard DeepSeek path. The transition is
   * one-way; re-enabling requires reloading the plugin with new
   * configuration. The drain is memoized: simultaneous callers share it.
   * Creation is refused while the drain is in flight. Teardown failures are
   * surfaced, not swallowed: every coordinator is still drained and the mode
   * is still latched, then an aggregate error is thrown.
   * @returns resolves once every live coordinator is drained and the
   *   mode is latched to `'off'`.
   * @throws an aggregate error when any coordinator teardown fails.
   */
  async rollbackToBaseline(): Promise<void> {
    return (this.rollbackPromise ??= this.doRollback())
  }

  /**
   * Rollback body. The creation barrier is latched synchronously — this
   * method runs to its first await without yielding — so a {@link create}
   * that starts after this call is refused even while drains are pending.
   *
   * This stays a TypeScript-private (not `#`-private) method because the
   * service is reached through a Cordis proxy, which cannot satisfy the
   * `#` brand check.
   */
  private doRollback(): Promise<void> {
    this.draining = true
    return (async (): Promise<void> => {
      const failures: string[] = []
      for (const dispose of [...this.liveCoordinators]) {
        try {
          await dispose()
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      this.config.mode = 'off'
      if (failures.length > 0) {
        throw new Error(
          `system1: rollback drained with ${failures.length} teardown failure(s): ${failures.join('; ')}`,
        )
      }
    })()
  }
}

export default System1Workflows

export { System1RequestId } from './request-id.ts'
export {
  TerminalInvariantError,
  finalizeTerminal,
} from './finalizer.ts'
export type {
  FinalizeTerminalRequest,
  FinalizerVerification,
} from './finalizer.ts'
export type {
  LeaseAuthority,
  System1Mode,
  System1Provider,
  System1WorkflowConfig,
  ResolvedSystem1WorkflowConfig,
  System1CoordinatorHandle,
} from './types.ts'
export type {
  System1EventBase,
  System1AdmissionData,
  System1RouteData,
  System1Candidate,
  System1CandidatesData,
  System1DecisionData,
  System1BudgetReservationData,
  System1PlannedStep,
  System1ExecutionIntentData,
  System1ExecutionSettlementData,
  System1VerificationData,
  System1HandoffData,
  System1ContextSelectionData,
  System1TerminalData,
  System1InboxData,
  System1EventType,
} from './events.ts'
export { SYSTEM1_EVENT_TYPES } from './events.ts'
export { System1Inbox } from './inbox.ts'
export { System1CoordinatorAgent } from './coordinator-agent.ts'
export type { CoordinatorDriver } from './coordinator-agent.ts'
export {
  HANDOFF_SCHEMA_VERSION,
  MAX_HANDOFF_DEPTH,
  checkReturnContract,
  extractHandoffResult,
  handoffToDeepSeek,
  parseChildResult,
  parseHandoffBundle,
  renderHandoffMessage,
  renderHandoffText,
} from './handoff.ts'
export type {
  HandoffBudget,
  HandoffBudgetLedger,
  HandoffBundle,
  HandoffChildResult,
  HandoffHandler,
  HandoffOptions,
  HandoffOutcome,
  HandoffReturnContract,
} from './handoff.ts'
export { spawnWorker } from './workers.ts'
export type {
  WorkerOptions,
  WorkerOutcome,
  WorkerSpec,
} from './workers.ts'
