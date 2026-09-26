/**
 * Live Jev smoke test: one real Choice call to the TypeSafe API.
 *
 * Usage: TYPESAFE_API_KEY=<key> pnpm --filter @deepseek-ai/dsh-system1-jev system1:live-smoke
 * Optional: TYPESAFE_JEV_MODEL overrides the pinned model (default jev-1.13.0).
 *
 * Exit codes: 0 on a validated decision, 1 on a live failure, 2 when skipped
 * (no API key). The skip is not a failure: CI runs keyless.
 *
 * The call goes through the real JevDecisionProvider.decide() code path, so
 * transport, strict normalization, and model pinning are exercised exactly
 * as production uses them. The API key is never logged or persisted.
 *
 * @module @deepseek-ai/dsh-system1-jev/live-smoke
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { System1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  Candidate,
  DecisionInput,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { JevDecisionProvider } from './jev-provider.ts'

/** Environment variable holding the TypeSafe API key. */
export const SMOKE_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Environment variable overriding the pinned model for the smoke run. */
export const SMOKE_MODEL_ENV = 'TYPESAFE_JEV_MODEL'

/** Pinned model used by default (matches the mocked fixtures). */
export const SMOKE_DEFAULT_MODEL = 'jev-1.13.0'

/** Per-call timeout for the single live request. */
const SMOKE_TIMEOUT_MS = 30_000

/** Resolved smoke configuration. */
export interface SmokeConfig {
  /** TypeSafe API key (never logged). */
  readonly apiKey: string
  /** Pinned Jev model ID to request. */
  readonly model: string
}

/**
 * Resolve the smoke configuration from the environment.
 * @param env - environment mapping (process.env in production).
 * @returns the config, or null when no API key is set (skip, not a failure).
 */
export function resolveSmokeConfig(env: NodeJS.ProcessEnv): SmokeConfig | null {
  const apiKey = env[SMOKE_API_KEY_ENV]
  if (!apiKey) return null
  return { apiKey, model: env[SMOKE_MODEL_ENV] ?? SMOKE_DEFAULT_MODEL }
}

/**
 * Build the minimal bounded Choice input: a trivial read-only routing
 * question with three candidates and an explicit escalation option.
 * @returns the DecisionInput for the single live call.
 */
export function buildSmokeInput(): DecisionInput {
  const candidates: Candidate[] = [
    {
      id: 'read-ci-status',
      label: 'Read the latest CI run status (read-only)',
      route: 'tool',
      effect: 'read',
      operationRef: 'smoke/ci-status',
      preconditionHash: 'smoke',
      verificationPolicyId: 'smoke',
    },
    {
      id: 'read-logs',
      label: 'Read recent log lines (read-only)',
      route: 'tool',
      effect: 'read',
      operationRef: 'smoke/logs',
      preconditionHash: 'smoke',
      verificationPolicyId: 'smoke',
    },
    {
      id: 'escalate',
      label: 'Escalate to a human reviewer',
      route: 'stop',
      effect: 'read',
      operationRef: 'smoke/escalate',
      preconditionHash: 'smoke',
      verificationPolicyId: 'smoke',
    },
  ]
  return {
    schemaVersion: 1,
    taskId: 'live-smoke',
    decisionId: 'live-smoke-d1',
    stateVersion: 0,
    policyVersion: 'live-smoke',
    catalogVersion: 'live-smoke',
    observationHash: 'live-smoke',
    questionFamily: 'live-smoke-routing',
    promptVersion: 'live-smoke/v1',
    state: 'Live smoke: verify the TypeSafe Jev API answers a bounded choice question.',
    candidates,
  }
}

/**
 * Print the validated decision fields (no credentials).
 * @param decision - the normalized decision returned by the provider.
 */
export function printSmokeDecision(decision: NormalizedDecision): void {
  console.log('live smoke: validated decision')
  console.log(`  model requested: ${decision.modelRequested}`)
  console.log(`  model resolved:  ${decision.modelResolved ?? 'null'}`)
  console.log(`  selected id:     ${decision.selectedId}`)
  console.log(`  selected prob:   ${decision.selectedProbability}`)
  console.log(`  vendor confidence:     ${decision.vendorConfidence ?? 'null'}`)
  console.log(`  calibrated correctness: ${decision.calibratedCorrectness ?? 'null'}`)
  console.log(`  calibration version:    ${decision.calibrationVersion ?? 'null'}`)
  console.log(`  usage: input=${decision.usage.inputTokens ?? 'unknown'} output=${decision.usage.outputTokens ?? 'unknown'}`)
  console.log(`  reason: ${decision.reasonCode}`)
  console.log(`  probabilities: ${JSON.stringify(decision.probabilities)}`)
}

/**
 * Run the smoke test against the live API.
 * @param env - environment mapping (process.env in production).
 * @returns 0 on success, 1 on a live failure, 2 when skipped for no key.
 */
/**
 * Run the live smoke against the TypeSafe API.
 * In tests, the JevDecisionProvider is mocked; no network calls are made.
 */
async function runLiveSmoke(config: SmokeConfig): Promise<number> {
  const provider = new JevDecisionProvider({
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: SMOKE_TIMEOUT_MS,
  })
  try {
    const decision = await provider.decide(buildSmokeInput(), AbortSignal.timeout(SMOKE_TIMEOUT_MS))
    printSmokeDecision(decision)
    return 0
  } catch (error) {
    if (error instanceof System1Error) {
      console.error(`live smoke failed: ${error.code}: ${error.message}`)
    } else {
      console.error(`live smoke failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 1
  }
}

export async function runSmoke(env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveSmokeConfig(env)
  if (config === null) {
    console.error(`skipped: no credentials (${SMOKE_API_KEY_ENV} is not set)`)
    return 2
  }
  return runLiveSmoke(config)
}

/** CLI entry: exit with the smoke run's code. */
/* v8 ignore next -- CLI entry point; requires a live TYPESAFE_API_KEY via process.env */
async function main(): Promise<void> {
  process.exitCode = await runSmoke(process.env)
}

/* v8 ignore next -- CLI guard; only runs when invoked directly as a script */
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main()
}
