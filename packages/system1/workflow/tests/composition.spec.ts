/** Real Loader composition for the System 1 workflow plugin.
 *
 * Boots a test-only `cordis.yml` through the real {@link Loader} and Include
 * machinery — the same entry path production uses — instead of hand-building
 * `ctx.plugin(...)`. The Loader imports entry modules through Node's native
 * resolver, which cannot resolve the workspace TS aliases, so the fixture
 * entry delegates to the source-plane module this test already imported: what
 * the Loader unwraps, validates, and instantiates is the real default export.
 * Only the injected `agents` dependency is hand-provided, as the real
 * {@link AgentRegistry} service. The assertions target lifecycle-visible
 * output: a live service, validated config, a registered coordinator runtime
 * root, config rejection, and disposal removing the registration.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as System1Module from '../src/index.ts'
import type { CoordinatorDriver, System1Workflows } from '../src/index.ts'

const MODULE_KEY = '__dshSystem1CompositionModule'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[MODULE_KEY]
})

interface Booted {
  ctx: Context
  entryFiber: () => Promise<void>
  entryState: () => unknown
}

/** Boot one test-only cordis.yml through the real Loader and Include. */
async function bootComposition(mode: string): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-system1-composition-'))
  tempRoots.push(dir)
  ;(globalThis as Record<string, unknown>)[MODULE_KEY] = System1Module
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
    ['- id: system1', `  name: ${fixtureUrl}`, '  config:', `    mode: ${mode}`, ''].join('\n'),
  )
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentRegistry)
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  const entryFiber = async (): Promise<void> => {
    const loader = ctx.loader as unknown as {
      entries(): Iterable<{ options: { id?: string }; fiber?: { dispose(): Promise<void> } | undefined }>
    }
    const entry = [...loader.entries()].find(candidate => candidate.options.id === 'system1')
    await entry?.fiber?.dispose()
  }
  const entryState = (): unknown => {
    const loader = ctx.loader as unknown as {
      entries(): Iterable<{ options: { id?: string }; fiber?: { state?: unknown } | undefined }>
    }
    const entry = [...loader.entries()].find(candidate => candidate.options.id === 'system1')
    return entry?.fiber?.state
  }
  return { ctx, entryFiber, entryState }
}

function service(ctx: Context): System1Workflows | undefined {
  return ctx.get('system1Workflows') as System1Workflows | undefined
}

const idleDriver: CoordinatorDriver = { run: () => Promise.resolve() }

describe('real Loader composition', () => {
  it('boots the default export and registers a coordinator runtime root', async () => {
    const { ctx } = await bootComposition('shadow')
    try {
      const workflows = service(ctx)
      expect(workflows).toBeDefined()
      // The Loader validated the cordis.yml config against the real schema.
      expect(workflows?.config.mode).toBe('shadow')
      // Durable, lifecycle-visible output: creating a coordinator through the
      // composed service registers a real custom runtime root, while the
      // standard DeepSeek factory stays untouched.
      const session = Session.create(SessionId('s-composition'))
      const handle = await workflows!.create(session, idleDriver)
      try {
        expect(ctx.agents.get(SessionId('s-composition')) === handle.coordinator).toBe(true)
      } finally {
        await handle.dispose()
      }
      expect(ctx.agents.get(SessionId('s-composition')) === undefined).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an invalid mode through Loader config validation', async () => {
    const { ctx, entryState } = await bootComposition('bogus')
    try {
      await ctx.loader.await()
      // The Loader marks the entry FAILED and never instantiates the service.
      expect(entryState()).toBe(FiberState.FAILED)
      expect(service(ctx)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes the registry contribution when the plugin fiber is disposed', async () => {
    const { ctx, entryFiber } = await bootComposition('shadow')
    try {
      const workflows = service(ctx)
      expect(workflows).toBeDefined()
      const session = Session.create(SessionId('s-hmr'))
      const handle = await workflows!.create(session, idleDriver)
      void handle
      // Compare booleans: printing a coordinator would crash the formatter
      // on its Cordis context proxy.
      expect(ctx.agents.get(SessionId('s-hmr')) !== undefined).toBe(true)
      // HMR disposes the plugin fiber on reload; the registry contribution
      // must go with it so a reloaded plugin starts clean.
      await entryFiber()
      expect(ctx.agents.get(SessionId('s-hmr')) !== undefined).toBe(false)
      expect(service(ctx)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
