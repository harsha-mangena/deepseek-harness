/** Production driver tests: one durable read-only turn through real composition.
 *
 * Boots a test-only `cordis.yml` through the real {@link Loader} — the same
 * entry path production uses — then creates a coordinator driven by the
 * {@link ReadOnlyProductionDriver}. The tool runtime, agent registry, and
 * coordinator are all real; only the Jev HTTP boundary is mocked (a fake
 * `decide` function, never a fake coordinator). Assertions target durable,
 * lifecycle-visible output: dispatched tool calls and `system1/terminal`
 * session events.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import * as WorkflowModule from '@deepseek-ai/dsh-system1-workflow'
import {
  System1RequestId,
  type HandoffBundle,
  type HandoffHandler,
  type System1CoordinatorAgent,
  type System1Workflows,
} from '@deepseek-ai/dsh-system1-workflow'
import {
  ReadOnlyProductionDriver,
  buildEscalationBundle,
  type ProductionDriverConfig,
  type ToolVerificationContext,
} from '@deepseek-ai/dsh-system1-integration'
import { PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type { CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import { fitIsotonic } from '@deepseek-ai/dsh-system1-calibration'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'
import type {
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

const MODULE_KEY = '__dshSystem1DriverModule'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[MODULE_KEY]
})

const EXPECTED_MODEL = 'jev-test-v1'

const catalog: CatalogTool[] = [
  {
    toolId: 'ci-runs',
    label: 'Read CI runs',
    route: 'tool',
    effect: 'read',
    operationRef: 'op:ci-runs:read:v1',
    preconditions: {},
    verificationPolicyId: 'verify:ci:v1',
  },
]

const profile: CapabilityProfile = {
  tenantId: 'default',
  profileVersion: 'v1',
  allowedEffects: new Set(['read']),
  allowedRoutes: new Set(['tool', 'stop']),
  globalRequiredGuards: [],
}

/** Calibration bound to the test decision context. */
function testCalibration(): IsotonicCalibration {
  return fitIsotonic(
    [
      { vendorConfidence: 0.1, correct: 0 },
      { vendorConfidence: 0.9, correct: 1 },
    ],
    'cal-v1',
    {
      model: EXPECTED_MODEL,
      promptVersion: 'p1',
      questionFamily: 'select-candidate',
    },
  )
}

function testDecision(
  selectedId: string,
  vendorConfidence: number | null = 0.9,
): NormalizedDecision {
  return {
    decisionId: 'd1',
    questionFamily: 'select-candidate',
    promptVersion: 'p1',
    selectedId,
    probabilities: { [selectedId]: 0.8 },
    selectedProbability: 0.8,
    vendorConfidence,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: EXPECTED_MODEL,
    modelResolved: EXPECTED_MODEL,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null },
    reasonCode: 'accepted',
  }
}

function makePolicy(): PolicyEngine {
  const policy = new PolicyEngine()
  policy.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: [] })
  policy.setEffectPolicy({ effect: 'stop', allowed: true, requiredGuards: [] })
  return policy
}

function userMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Boot the workflow plugin through the real Loader. */
async function boot(): Promise<{ ctx: Context; workflows: System1Workflows }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-system1-driver-'))
  tempRoots.push(dir)
  ;(globalThis as Record<string, unknown>)[MODULE_KEY] = WorkflowModule
  writeFileSync(
    join(dir, 'system1-entry.mjs'),
    [
      `const mod = globalThis[${JSON.stringify(MODULE_KEY)}]`,
      'export const { Config } = mod',
      'export default mod.default',
      '',
    ].join('\n'),
  )
  const fixtureUrl = pathToFileURL(join(dir, 'system1-entry.mjs')).href
  writeFileSync(
    join(dir, 'cordis.yml'),
    ['- id: system1', `  name: ${fixtureUrl}`, '  config:', '    mode: shadow', ''].join(
      '\n',
    ),
  )
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  const workflows = ctx.get('system1Workflows') as System1Workflows
  return { ctx, workflows }
}

function makeDriver(
  overrides: Partial<ProductionDriverConfig> = {},
): ReadOnlyProductionDriver {
  const provider: DecisionProvider =
    overrides.provider ?? {
      decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
    }
  return new ReadOnlyProductionDriver({
    policy: makePolicy(),
    capabilityProfile: profile,
    provider,
    catalog,
    calibration: testCalibration(),
    expectedModel: EXPECTED_MODEL,
    tenantId: 'tenant-test',
    resolveCall: () => ({ name: 'ci-status', arguments: {} }),
    verify: (ctx) => ({
      checkId: `verify:${ctx.receiptRef}`,
      passed: JSON.stringify(ctx.result.value).includes('green'),
    }),
    newRequestId: () => System1RequestId('req-test'),
    newCallId: () => ToolCallId('call-test'),
    ...overrides,
  })
}

interface TurnSetup {
  ctx: Context
  session: Session
  coordinator: System1CoordinatorAgent
  toolRan: () => boolean
  dispose: () => Promise<void>
}

/** Create a coordinator with a real scoped tool and run one driver turn. */
async function runTurn(
  sessionId: string,
  driver: ReadOnlyProductionDriver,
): Promise<TurnSetup> {
  const { ctx, workflows } = await boot()
  const session = Session.create(SessionId(sessionId))
  const handle = await workflows.create(session, driver)
  let ran = false
  handle.coordinator.ctx.tools.register(
    defineContentToolFixture({
      name: 'ci-status',
      description: 'CI status reader',
      parameters: {},
      async execute() {
        ran = true
        return [{ type: 'text', text: 'CI is green' }]
      },
    }),
  )
  handle.coordinator.followup(userMessage('Check CI status'))
  await handle.coordinator.whenIdle()
  return {
    ctx,
    session,
    coordinator: handle.coordinator,
    toolRan: () => ran,
    dispose: async () => {
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** Terminal events recorded in the session log. */
function terminals(session: Session): Array<{ outcome: string; verifiedBy?: readonly string[] }> {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/terminal')
    .map((event) => {
      const data = event.data as { outcome: string; verifiedBy?: readonly string[] }
      return { outcome: data.outcome, verifiedBy: data.verifiedBy }
    })
}


import { McpAdapter } from '@deepseek-ai/dsh-system1-mcp'
import { generateCandidateMenu } from '@deepseek-ai/dsh-system1-observations'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release=r }); return { promise, release } }

describe('independent revision probes', () => {
  it('V01 shadow never dispatches the System 1 selected tool', async () => {
    const s = await runTurn('v01', makeDriver())
    try { expect(s.toolRan()).toBe(false) } finally { await s.dispose() }
  })
  it('V02 recovery does not requeue a completed request', async () => {
    const s = await runTurn('v02', makeDriver())
    try { s.coordinator.recover(); expect(s.coordinator.inbox.nextTurn).toHaveLength(0) }
    finally { await s.dispose() }
  })
  it('V03 cancelled pending input stays cancelled after recovery', async () => {
    const {ctx,workflows}=await boot(); const h=await workflows.create(Session.create(SessionId('v03')), {run: async()=>{}})
    try { h.coordinator.send(userMessage('cancel me'), 'next-turn', false); h.coordinator.cancel(); h.coordinator.recover(); expect(h.coordinator.inbox.nextTurn).toHaveLength(0) }
    finally { await h.dispose(); await ctx.fiber.dispose() }
  })
  it('V04 injected model context survives recovery', async () => {
    const {ctx,workflows}=await boot(); const h=await workflows.create(Session.create(SessionId('v04')), {run: async()=>{}})
    try { h.coordinator.inject(userMessage('critical context')); h.coordinator.recover(); expect(h.coordinator.inbox.nextStep).toHaveLength(1) }
    finally { await h.dispose(); await ctx.fiber.dispose() }
  })
  it('V05 disposal waits for maintenance to settle', async () => {
    const {ctx,workflows}=await boot(); const h=await workflows.create(Session.create(SessionId('v05')), {run: async()=>{}})
    const g=gate(); const pending=h.coordinator.runMaintenance(async()=>{ await g.promise }); let done=false
    const disposal=h.coordinator.dispose().then(()=>{done=true})
    try { await tick(); expect(done).toBe(false) }
    finally { g.release(); await pending; await disposal; await h.dispose(); await ctx.fiber.dispose() }
  })
  it('V06 a wake is deferred until active maintenance settles', async () => {
    const {ctx,workflows}=await boot(); let runs=0; const h=await workflows.create(Session.create(SessionId('v06')), {run: async()=>{runs++}})
    const g=gate(); const pending=h.coordinator.runMaintenance(async()=>{await g.promise})
    try { h.coordinator.followup(userMessage('later')); await tick(); expect(runs).toBe(0) }
    finally { g.release(); await pending; await h.dispose(); await ctx.fiber.dispose() }
  })
  it('V07 coordinator owns initiator even when another agent wakes it', async () => {
    const {ctx,workflows}=await boot(); let seen: string|undefined
    const a=await workflows.create(Session.create(SessionId('v07-a')), {run: async()=>{}})
    const b=await workflows.create(Session.create(SessionId('v07-b')), {run: async c=>{seen=c.ctx.agents.currentInitiator()?.id}})
    try { ctx.agents.withInitiator(a.coordinator,()=>b.coordinator.followup(userMessage('go'))); await b.coordinator.whenIdle(); expect(seen).toBe('v07-b') }
    finally { await a.dispose(); await b.dispose(); await ctx.fiber.dispose() }
  })
  it('V08 rollback refuses new coordinator creation while draining', async () => {
    const {ctx,workflows}=await boot(); const g=gate(); const h=await workflows.create(Session.create(SessionId('v08')), {run: async()=>{await g.promise}})
    h.coordinator.followup(userMessage('go')); const rollback=workflows.rollbackToBaseline()
    let late: Awaited<ReturnType<System1Workflows['create']>>|undefined; let rejected=false
    try {
      try { late=await workflows.create(Session.create(SessionId('v08-late')), {run: async()=>{}}) } catch { rejected=true }
      expect(rejected).toBe(true)
    } finally { g.release(); await rollback; await late?.dispose(); await h.dispose(); await ctx.fiber.dispose() }
  })
  it('V09 low confidence invokes the configured DeepSeek fallback', async () => {
    let calls=0; const s=await runTurn('v09',makeDriver({
      provider:{decide:async input=>({...testDecision('c1',0.1),decisionId:input.decisionId})},
      handoff:async()=>{calls++; return {kind:'completed',artifacts:[],evidence:[],actualUnits:0}},
      handoffBudget:{poolName:'pool',units:10}
    }))
    try { expect(calls).toBe(1) } finally { await s.dispose() }
  })
  it('V10 provider outage invokes the configured DeepSeek fallback', async () => {
    let calls=0; const s=await runTurn('v10',makeDriver({
      provider:{decide:async()=>{throw system1Error('PROVIDER_TIMEOUT','timeout',{})}},
      handoff:async()=>{calls++; return {kind:'completed',artifacts:[],evidence:[],actualUnits:0}},
      handoffBudget:{poolName:'pool',units:10}
    }))
    try { expect(calls).toBe(1) } finally { await s.dispose() }
  })
  it('V11 verified tool evidence is retrievable from the session', async () => {
    const s=await runTurn('v11',makeDriver())
    try { expect(s.session.snapshotEvents().some(e=>e.type==='tool/result')).toBe(true) }
    finally { await s.dispose() }
  })
  it('V12 tenant mismatch between profile and request denies dispatch', async () => {
    const s=await runTurn('v12',makeDriver({capabilityProfile:{...profile,tenantId:'tenant-a'},tenantId:'tenant-b'}))
    try { expect(s.toolRan()).toBe(false) } finally { await s.dispose() }
  })
  it('V13 delegation cancellation reaches active delegated work', async () => {
    const {ctx,workflows}=await boot(); const h=await workflows.create(Session.create(SessionId('v13')), {run: async()=>{}})
    const g=gate(); let delegatedSignal: AbortSignal|undefined
    const pending=h.coordinator.delegate(1,0,async signal=>{delegatedSignal=signal; await g.promise})
    try { h.coordinator.cancel(); expect(delegatedSignal?.aborted).toBe(true) }
    finally {g.release(); await pending; await h.dispose(); await ctx.fiber.dispose()}
  })
  it('V14 unknown MCP operation never skips schema validation', async () => {
    let calls=0;const a=new McpAdapter({executor:{execute:async()=>{calls++;return 'ran'}}})
    const c=generateCandidateMenu([{toolId:'mcp:read',label:'read',route:'tool',effect:'read',operationRef:'op:mcp:read:v1',preconditions:{},verificationPolicyId:'v'}])[0]!
    try {await a.executeCandidate(c,{bad:true},new AbortController().signal)} catch {}
    expect(calls).toBe(0)
  })
  it('V15 MCP validates nested properties without redundant type keyword', async () => {
    let calls=0;const a=new McpAdapter({executor:{execute:async()=>{calls++;return 'ran'}}})
    const tool=a.adaptTool({name:'read',description:'read',mutates:false,inputSchema:{type:'object',properties:{filters:{properties:{repo:{type:'string'}}}}}},'v')
    try {await a.executeCandidate(generateCandidateMenu([tool])[0]!,{filters:{repo:42}},new AbortController().signal)}catch{}
    expect(calls).toBe(0)
  })
  it('V16 MCP enforces schema-valued additionalProperties', async () => {
    let calls=0;const a=new McpAdapter({executor:{execute:async()=>{calls++;return 'ran'}}})
    const tool=a.adaptTool({name:'read',description:'read',mutates:false,inputSchema:{type:'object',additionalProperties:{type:'string'}}},'v')
    try{await a.executeCandidate(generateCandidateMenu([tool])[0]!,{repo:42},new AbortController().signal)}catch{}
    expect(calls).toBe(0)
  })
  it('V17 half-open circuit permits only one concurrent probe', async () => {
    let now=0;let calls=0;const g=gate();const a=new McpAdapter({failureThreshold:1,resetTimeoutMs:1,now:()=>now,executor:{execute:async()=>{calls++;if(calls===1)throw Error('offline');await g.promise;return 'ok'}}})
    const c=generateCandidateMenu([a.adaptTool({name:'read',description:'read',mutates:false,inputSchema:{}},'v')])[0]!
    try{await a.executeCandidate(c,{},new AbortController().signal)}catch{}
    now=2;const p1=a.executeCandidate(c,{},new AbortController().signal);const p2=a.executeCandidate(c,{},new AbortController().signal).catch(()=>undefined)
    try {expect(calls).toBe(2)}finally{g.release();await Promise.all([p1,p2])}
  })
  it('V18 typed transport failure after mutation dispatch reports unknown effect', async () => {
    const a=new McpAdapter({executor:{execute:async()=>{throw system1Error('PROVIDER_TIMEOUT','receipt lost',{})}}})
    const c=generateCandidateMenu([a.adaptTool({name:'write',description:'write',mutates:true,inputSchema:{}},'verify')])[0]!
    await expect(a.executeCandidate(c,{},new AbortController().signal)).rejects.toMatchObject({code:'EXECUTION_UNKNOWN'})
  })
})
