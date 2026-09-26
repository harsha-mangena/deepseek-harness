/**
 * Positive controls: reviewer-verified behaviors that must keep working.
 *
 * C01 pins acceptance of the documented complete Choice response.
 * C03 pins the real HTTP request shape against a local TypeSafe-compatible
 * fixture (no live service; loopback only).
 */

import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { JevDecisionProvider, normalizeJevResponse } from '@deepseek-ai/dsh-system1-jev'
import type { DecisionInput } from '@deepseek-ai/dsh-system1-contracts'

const decisionInput: DecisionInput = {
  schemaVersion: 1,
  taskId: 't',
  decisionId: 'd',
  stateVersion: 1,
  policyVersion: 'p1',
  catalogVersion: 'c1',
  observationHash: 'h',
  questionFamily: 'select-candidate',
  promptVersion: 'p1',
  state: 'Read CI',
  candidates: [
    {
      id: 'c1', label: 'Read CI runs', route: 'tool', effect: 'read',
      operationRef: 'op:mcp:ci:v1', preconditionHash: 'v1', verificationPolicyId: 'verify-ci',
    },
    {
      id: 'escalate-none', label: 'Escalate', route: 'stop', effect: 'stop',
      operationRef: 'op:stop', preconditionHash: 'v1', verificationPolicyId: '',
    },
  ],
}

function choiceResponse() {
  return {
    model: 'jev-1.13.0',
    answers: {
      'select-candidate': {
        type: 'choice',
        choice: 'c1',
        confidence: 0.9,
        probabilities: { c1: 0.99, 'escalate-none': 0.01 },
      },
    },
    usage: { input_tokens: 12, output_tokens: 4 },
  }
}

describe('positive controls', () => {
  it('C01 accepts the documented complete Choice response', () => {
    const decision = normalizeJevResponse(choiceResponse(), decisionInput, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c1')
    expect(decision.usage.inputTokens).toBe(12)
    expect(decision.usage.outputTokens).toBe(4)
    expect(decision.modelResolved).toBe('jev-1.13.0')
  })

  it('C03 sends a correctly formed request through real HTTP transport', async () => {
    let requestPath: string | undefined
    let requestBody = ''
    const server = createServer(async (req, res) => {
      requestPath = req.url
      for await (const chunk of req) {
        requestBody += chunk.toString()
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(choiceResponse()))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address() as AddressInfo
      // Direct node:http transport: immune to ambient proxy settings
      // (NODE_USE_ENV_PROXY binds Node's built-in fetch at process start).
      const directFetch: typeof fetch = async (url, init) => {
        const target = new URL(String(url))
        const headers = new Headers(init?.headers)
        const bodyText = String(init?.body ?? '')
        return new Promise<Response>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: target.hostname,
              port: target.port,
              path: `${target.pathname}${target.search}`,
              method: init?.method ?? 'GET',
              headers: Object.fromEntries(headers.entries()),
            },
            res => {
              const chunks: Buffer[] = []
              res.on('data', chunk => chunks.push(chunk as Buffer))
              res.on('end', () => {
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: res.statusCode ?? 500,
                    headers: { 'Content-Type': 'application/json' },
                  }),
                )
              })
              res.on('error', reject)
            },
          )
          req.on('error', reject)
          init?.signal?.addEventListener('abort', () => {
            req.destroy()
            reject(new DOMException('aborted', 'AbortError'))
          })
          req.end(bodyText)
        })
      }
      const provider = new JevDecisionProvider({
        apiKey: 'synthetic-control-key',
        model: 'jev-1.13.0',
        baseUrl: `http://127.0.0.1:${address.port}`,
        maxTransportRetries: 0,
        fetchFn: directFetch,
      })
      const decision = await provider.decide(decisionInput, new AbortController().signal)
      expect(decision.selectedId).toBe('c1')
      expect(requestPath).toBe('/v1/systemone')
      const body = JSON.parse(requestBody) as {
        questions: Record<string, { criteria: Record<string, string> }>
      }
      expect(body.questions['select-candidate'].criteria['c1']).toBe('Read CI runs')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
    }
  })
})
