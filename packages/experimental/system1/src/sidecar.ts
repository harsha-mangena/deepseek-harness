/**
 * Local Laya sidecar process manager. Laya runs as a small Python sidecar so
 * the harness needs no API key; this module starts it on demand, waits for
 * readiness, and stops it on plugin disposal.
 *
 * If the `laya` Python package is not installed or the sidecar fails to start,
 * the backend reports unavailable and the service falls back to existing
 * harness behavior. Starting the sidecar is best-effort and never blocks
 * agent traffic.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Lifecycle handle for one local Laya sidecar. */
export interface LayaSidecar {
  /** Resolve when the sidecar answers readiness probes, or reject. */
  readonly ready: Promise<string>
  /** Base URL of the sidecar decision endpoint (without trailing path). */
  readonly baseUrl: string
  /** Stop the sidecar. Never throws. */
  stop(): Promise<void>
}

const READY_TIMEOUT_MS = 20_000
const PROBE_INTERVAL_MS = 250

async function waitForReady(baseUrl: string, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (signal.aborted) throw new Error('laya sidecar start aborted')
    try {
      const response = await fetch(`${baseUrl}/health`, { signal })
      if (response.ok) return baseUrl
    } catch {
      // Not up yet; keep probing until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`laya sidecar did not become ready within ${READY_TIMEOUT_MS}ms`)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROBE_INTERVAL_MS)
    })
  }
}

/**
 * Start a local Laya sidecar by spawning `command` (default `python3 -m
 * laya_serve --port <free port>`). The command must serve `GET /health` and
 * `POST /decide`.
 *
 * @param command - argv used to launch the sidecar.
 * @param logger - host logger for lifecycle diagnostics.
 */
export function startLayaSidecar(
  command: readonly string[],
  logger: { warn(message: string, ...args: unknown[]): void },
): LayaSidecar {
  const [bin, ...args] = command
  if (bin === undefined) throw new Error('system1: layaCommand must not be empty')
  // Bind a loopback port chosen by the OS; the sidecar inherits it via env.
  const port = 17840 + Math.floor(Math.random() * 1000)
  const baseUrl = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn(bin, [...args, '--port', String(port)], {
    env: { ...process.env, LAYA_PORT: String(port) },
    stdio: 'ignore',
  })
  const aborter = new AbortController()
  let stopped = false

  const ready = (async (): Promise<string> => {
    try {
      await waitForReady(baseUrl, aborter.signal)
      return baseUrl
    } catch (error: unknown) {
      logger.warn('system1: laya sidecar failed to start: %o', error)
      await stop()
      throw error
    }
  })()

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    aborter.abort()
    child.kill()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    }).catch(() => undefined)
  }

  return { ready, baseUrl, stop }
}
