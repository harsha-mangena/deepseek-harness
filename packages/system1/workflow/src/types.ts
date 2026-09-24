/**
 * Core System 1 types shared across the workflow, decision, and context packages.
 *
 * @module @deepseek-ai/dsh-system1-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { System1CoordinatorAgent } from './coordinator-agent.ts'

/**
 * Opaque identifier for one System 1 workflow request, from admission to
 * terminal settlement. Stable across coordinator restarts so replay can
 * reattach durable events to the workflow they belong to.
 *
 * Use {@linkcode System1RequestId} from `./request-id.ts` to construct one.
 */
export type System1RequestId = Branded<'System1RequestId'>

/** Operating posture of the System 1 integration. */
export type System1Mode =
  /** Plugin loaded but refuses coordinator creation; the standard DeepSeek path is untouched. */
  | 'off'
  /** Coordinators run and record decisions, but every decision is advisory: DeepSeek still executes. */
  | 'shadow'
  /** Coordinators run and own routing/execution decisions for admitted work. */
  | 'enforce'

/**
 * Execution provider backing System 1 decisions. Jev is the only supported
 * provider; this stays a closed union so adding a provider is a deliberate,
 * reviewed change rather than a config accident.
 */
export type System1Provider = 'jev'

/**
 * Workflow plugin configuration: operating posture, decision provider, and
 * Jev model selection. Schemastery fills defaults; absent fields resolve to
 * the values documented on each property.
 */
export interface System1WorkflowConfig {
  /** Operating posture; `off` keeps the plugin inert. Defaults to `off`. */
  mode?: System1Mode
  /** Decision provider; only `jev` is supported. Defaults to `jev`. */
  provider?: System1Provider
  /** Jev model name resolved at call time; omit to let Jev resolve the pinned default. */
  model?: string
}

/** Resolved workflow plugin configuration; every field has a value. */
export interface ResolvedSystem1WorkflowConfig {
  /** Operating posture; `off` refuses coordinator creation. */
  mode: System1Mode
  /** Decision provider; only `jev` is supported. */
  provider: System1Provider
  /** Jev model name, or `undefined` to let Jev resolve the pinned default. */
  model: string | undefined
}

/**
 * Owned lifecycle for one coordinator: drains the driver, unwinds the
 * coordinator's owned effects, then unregisters the agent. Session
 * detachment stays with the session store; the handle never closes a
 * session it did not open.
 */
export interface System1CoordinatorHandle {
  /** The registered coordinator agent. */
  coordinator: System1CoordinatorAgent
  /**
   * Full teardown in dependency order: cancel and drain the driver,
   * unwind coordinator-owned effects, unregister the agent.
   * @returns resolves when the coordinator is fully unregistered.
   */
  dispose(): Promise<void>
}
