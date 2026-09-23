/**
 * Coverage for the deferred Laya backend ({@link LayaBackend}) and the local
 * sidecar manager ({@link startLayaSidecar}). Laya is deferred — these tests
 * pin current behavior with stubbed fetch and throwaway local processes; no
 * real Laya installation is needed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayaBackend } from '../src/backends/laya.ts'
import { startLayaSidecar, type LayaSidecar } from '../src/sidecar.ts'
import type { System1Question, System1RuntimeConfig } from '../src/types.ts'

function runtime(overrides: Partial<System1RuntimeConfig> = {}): System1RuntimeConfig {
  return {
    backend: 'laya',
    mode: 'shadow',
    enabled: true,
    confidenceThreshold: 0.7,
    thresholds: {},
    budgetPerTurn: 4,
    budgetPerTask: 12,
    timeoutMs: 1200,
    failureThreshold: 3,
    cooldownMs: 30_000,
    traceBufferSize: 200,
    delegationWeights: { novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 },
    jevApiKeyEnv: 'SYSTEM1_TEST_TYPESAFE_KEY',
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    jevModel: 'jev-latest',
    layaEndpoint: 'http://127.0.0.1:1/decide',
    layaAutoStart: false,
    layaCommand: ['node', '--version'],
    ...overrides,
  }
}

function question(): System1Question {
  return {
    kind: 'triage',
    primitive: 'choice',
    prompt: 'How much reasoning does this agent step need?',
    context: { messagePreview: 'hi' },
    options: { trivial: 'no reasoning needed', complex: 'full reasoning' },
  }
}

const logger = { warn: vi.fn() }

interface SeenRequest {
  url: string
  init: RequestInit
}

function requestBody(init: RequestInit): unknown {
  const body = init.body
  if (typeof body !== 'string') throw new Error('expected a string request body')
  return JSON.parse(body)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  logger.warn.mockClear()
})

// Fixture servers live in temp files: `node -e <script> --port <n>` treats the
// `--port` flag appended by startLayaSidecar as a node option and exits with
// "bad option", while a script file receives it as an ordinary argument. The
// servers read the port from LAYA_PORT instead.
const fixtureDir = mkdtempSync(join(tmpdir(), 'laya-sidecar-coverage-'))

function writeFixture(name: string, content: string): string {
  const file = join(fixtureDir, name)
  writeFileSync(file, content)
  return file
}

// Serves GET /health and POST /decide, echoing the question kind as the answer.
const serverFile = writeFixture(
  'server.mjs',
  `import http from 'node:http'
const port = Number(process.env.LAYA_PORT)
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method === 'POST' && req.url === '/decide') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const asked = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ answer: asked.kind, confidence: 0.95 }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, '127.0.0.1')
`,
)

// Answers the first /health probe with 500, then 200.
const flakyFile = writeFixture(
  'flaky.mjs',
  `import http from 'node:http'
const port = Number(process.env.LAYA_PORT)
let n = 0
http.createServer((req, res) => {
  n += 1
  res.writeHead(n <= 1 ? 500 : 200)
  res.end()
}).listen(port, '127.0.0.1')
`,
)

// Serves /health 200 and ignores SIGTERM, so stop() must escalate to SIGKILL.
// Readiness implies the script fully ran, so the handler is installed.
const sturdyFile = writeFixture(
  'sturdy.mjs',
  `import http from 'node:http'
const port = Number(process.env.LAYA_PORT)
process.on('SIGTERM', () => {})
http.createServer((req, res) => {
  res.writeHead(200)
  res.end()
}).listen(port, '127.0.0.1')
`,
)

// Never serves anything; stays alive until signalled.
const sleepFile = writeFixture('sleep.mjs', 'setInterval(() => {}, 1000)\n')

describe('LayaBackend with a configured endpoint', () => {
  function stubDecide(body: unknown, status = 200): SeenRequest[] {
    const seen: SeenRequest[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    return seen
  }

  it('posts the question fields to <endpoint>/decide and returns the judgment', async () => {
    const seen = stubDecide({ answer: 'x', confidence: 0.9 })
    const backend = new LayaBackend(runtime(), logger)
    const judgment = await backend.decide(
      { ...question(), levels: ['l1', 'l2'] },
      new AbortController().signal,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://127.0.0.1:1/decide')
    expect(seen[0]?.init.method).toBe('POST')
    expect(seen[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(requestBody(seen[0]?.init ?? {})).toEqual({
      kind: 'triage',
      primitive: 'choice',
      prompt: 'How much reasoning does this agent step need?',
      context: { messagePreview: 'hi' },
      options: { trivial: 'no reasoning needed', complex: 'full reasoning' },
      levels: ['l1', 'l2'],
    })
    expect(judgment).toMatchObject({
      answer: 'x',
      confidence: 0.9,
      backend: 'laya',
      abstained: false,
    })
    expect(judgment.latencyMs).toEqual(expect.any(Number))
    await backend.dispose()
  })

  it('sends null options when the question has none', async () => {
    const seen = stubDecide({ answer: 'x', confidence: 0.9 })
    const backend = new LayaBackend(runtime(), logger)
    const { options: _omitted, ...withoutOptions } = question()
    await backend.decide(withoutOptions, new AbortController().signal)
    expect(requestBody(seen[0]?.init ?? {})).toMatchObject({ options: null })
    await backend.dispose()
  })

  it('throws on a non-ok sidecar response', async () => {
    stubDecide('boom', 503)
    const backend = new LayaBackend(runtime(), logger)
    await expect(backend.decide(question(), new AbortController().signal)).rejects.toThrow(
      'laya sidecar returned HTTP 503',
    )
    await backend.dispose()
  })

  it('defaults a missing confidence to 0 and honors abstained', async () => {
    stubDecide({ abstained: true })
    const backend = new LayaBackend(runtime(), logger)
    const judgment = await backend.decide(question(), new AbortController().signal)
    expect(judgment).toMatchObject({ answer: null, confidence: 0, backend: 'laya', abstained: true })
    await backend.dispose()
  })

  it('asks questions in turn via decideMany', async () => {
    const seen = stubDecide({ answer: 'x', confidence: 0.9 })
    const backend = new LayaBackend(runtime(), logger)
    const judgments = await backend.decideMany(
      [question(), question()],
      new AbortController().signal,
    )
    expect(judgments).toHaveLength(2)
    expect(seen).toHaveLength(2)
    for (const judgment of judgments) {
      expect(judgment.backend).toBe('laya')
    }
    await backend.dispose()
  })

  it('dispose without a started sidecar does not throw', async () => {
    const backend = new LayaBackend(runtime(), logger)
    await expect(backend.dispose()).resolves.toBeUndefined()
  })

  it('dispose swallows a rejecting sidecar stop', async () => {
    const backend = new LayaBackend(runtime(), logger)
    // The real stop() never rejects by contract, so install a failing double
    // to pin dispose's defensive catch. `sidecar` is TS-private (no runtime
    // enforcement), so assign it directly with precise types and no cast.
    const failing: LayaSidecar = {
      ready: Promise.resolve('http://127.0.0.1:1'),
      baseUrl: 'http://127.0.0.1:1',
      stop: () => Promise.reject(new Error('stop failed')),
    }
    Object.assign(backend, { sidecar: failing })
    await expect(backend.dispose()).resolves.toBeUndefined()
    const snapshot: { sidecar?: unknown } = {}
    Object.assign(snapshot, backend)
    expect(snapshot.sidecar).toBeNull()
  })
})

describe('LayaBackend with layaAutoStart', () => {
  it('decides end-to-end through one auto-started sidecar, reusing it', async () => {
    const backend = new LayaBackend(
      runtime({ layaAutoStart: true, layaCommand: ['node', serverFile] }),
      logger,
    )
    const signal = new AbortController().signal
    // Two concurrent decides share a single start attempt; the third decide
    // reuses the cached base URL without spawning again.
    const [first, second] = await Promise.all([
      backend.decide(question(), signal),
      backend.decide(question(), signal),
    ])
    for (const judgment of [first, second]) {
      expect(judgment).toMatchObject({
        answer: 'triage',
        confidence: 0.95,
        backend: 'laya',
        abstained: false,
      })
      expect(judgment.latencyMs).toEqual(expect.any(Number))
    }
    const third = await backend.decide(question(), signal)
    expect(third.answer).toBe('triage')
    await backend.dispose()
    await expect(backend.dispose()).resolves.toBeUndefined()
  }, 15_000)
})

describe('startLayaSidecar', () => {
  function settledMessage(sidecar: LayaSidecar): Promise<string> {
    return sidecar.ready.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  }

  it('throws on an empty command', () => {
    expect(() => startLayaSidecar([], logger)).toThrow(
      'system1: layaCommand must not be empty',
    )
  })

  it('stop on an already-exited process never throws', async () => {
    const sidecar = startLayaSidecar(['true'], logger)
    const settled = settledMessage(sidecar)
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(sidecar.stop()).resolves.toBeUndefined()
    await expect(sidecar.stop()).resolves.toBeUndefined()
    await expect(settled).resolves.toBe('laya sidecar start aborted')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('rejects promptly when stop aborts the readiness wait', async () => {
    const sidecar = startLayaSidecar(['node', sleepFile], logger)
    const settled = settledMessage(sidecar)
    await sidecar.stop()
    await expect(settled).resolves.toBe('laya sidecar start aborted')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('keeps probing while /health answers but is not ok', async () => {
    const sidecar = startLayaSidecar(['node', flakyFile], logger)
    await expect(sidecar.ready).resolves.toBe(sidecar.baseUrl)
    await sidecar.stop()
  }, 15_000)

  it('rejects at the readiness deadline without waiting it out', async () => {
    // Fast-forward past READY_TIMEOUT_MS: every Date.now() call advances the
    // clock by more than the timeout, so the first deadline check throws no
    // matter how many stray calls happen in between.
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 100_000))
    try {
      const sidecar = startLayaSidecar(['node', sleepFile], logger)
      await expect(sidecar.ready).rejects.toThrow(
        'laya sidecar did not become ready within 20000ms',
      )
      expect(logger.warn).toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it('stop swallows an internal timer failure via its defensive catch', async () => {
    const sidecar = startLayaSidecar(['node', sleepFile], logger)
    // The background readiness wait rejects once the timer mock breaks it;
    // handle it here so it never surfaces as an unhandled rejection.
    const settled = settledMessage(sidecar)
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      throw new Error('timer failed')
    })
    try {
      // The child is alive, so stop() reaches its internal setTimeout; the
      // throw inside the promise executor exercises the defensive catch.
      await expect(sidecar.stop()).resolves.toBeUndefined()
    } finally {
      timerSpy.mockRestore()
    }
    await expect(settled).resolves.toMatch(/timer failed|aborted/)
  })

  it('escalates to SIGKILL when the sidecar ignores SIGTERM', async () => {
    const sidecar = startLayaSidecar(['node', sturdyFile], logger)
    // Readiness proves the server script fully ran, so its SIGTERM handler is
    // installed; signalling any earlier would kill the child during boot.
    await sidecar.ready
    const started = Date.now()
    await sidecar.stop()
    // The 3000ms SIGKILL timer fired instead of the fast exit path.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500)
  }, 15_000)
})
