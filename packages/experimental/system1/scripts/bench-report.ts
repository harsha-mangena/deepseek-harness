/**
 * Paired benchmark report for System 1 A/B runs.
 *
 * Input: JSONL, one row per run:
 *   { "task": "S1-flag", "condition": "off" | "shadow" | "enforce-async" | "enforce-blocking",
 *     "block": 7,                      // pairing key: runs sharing (task, block) are compared
 *     "success": true,
 *     "wallMs": 5400,                  // start → agent/turn-stopping (NOT process exit)
 *     "steps": 4, "toolCalls": 5,
 *     "cacheHitTokens": 18000, "cacheMissTokens": 900, "outputTokens": 350,
 *     "costUsd": 0.0012,
 *     "jevCalls": 3, "criticalWaitMs": 210, "late": 0 }
 *
 * Output: per task and condition, medians vs the baseline condition, paired
 * log-ratio Wilcoxon signed-rank (normal approximation), bootstrap 95% CI
 * of the median ratio, McNemar on success, and the pairs needed to detect
 * a 20% change at the observed variability. Shadow vs off must show NO
 * difference — if it does, the run is confounded (order, cache, time of
 * day) and every other comparison is invalid; the report says so.
 *
 * Usage: pnpm exec tsx packages/experimental/system1/scripts/bench-report.ts runs.jsonl [--baseline off]
 */

import { readFileSync } from 'node:fs'

interface Row {
  task: string
  condition: string
  block: number
  success: boolean
  wallMs: number
  steps: number
  toolCalls: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  costUsd: number
  jevCalls?: number
  criticalWaitMs?: number
  late?: number
}

const METRICS = ['costUsd', 'wallMs', 'steps', 'toolCalls', 'cacheMissTokens', 'outputTokens'] as const

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] as number : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** Two-sided Wilcoxon signed-rank p-value (normal approximation, tie-corrected ranks). */
export function wilcoxon(differences: readonly number[]): number {
  const nonzero = differences.filter(d => d !== 0)
  const n = nonzero.length
  if (n < 6) return NaN
  const ranked = nonzero.map(d => ({ d, a: Math.abs(d) })).sort((x, y) => x.a - y.a)
  const ranks = new Array<number>(n)
  for (let i = 0; i < n;) {
    let j = i
    while (j + 1 < n && ranked[j + 1]!.a === ranked[i]!.a) j += 1
    for (let k = i; k <= j; k += 1) ranks[k] = (i + j) / 2 + 1
    i = j + 1
  }
  const wPlus = ranked.reduce((sum, item, index) => sum + (item.d > 0 ? ranks[index]! : 0), 0)
  const mean = n * (n + 1) / 4
  const sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
  const z = (wPlus - mean) / sd
  return 2 * (1 - normalCdf(Math.abs(z)))
}

/** Bootstrap 95% CI of the median of `values` (deterministic LCG seed). */
export function bootstrapMedianCi(values: readonly number[], iterations = 2000): [number, number] {
  if (values.length === 0) return [NaN, NaN]
  let seed = 42
  const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const medians: number[] = []
  for (let i = 0; i < iterations; i += 1) {
    medians.push(median(values.map(() => values[Math.floor(random() * values.length)] as number)))
  }
  medians.sort((a, b) => a - b)
  return [medians[Math.floor(0.025 * iterations)] as number, medians[Math.floor(0.975 * iterations)] as number]
}

/** Exact-binomial McNemar p-value on discordant pairs (b: base ok/other fail, c: reverse). */
export function mcnemar(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  let tail = 0
  let coef = 1
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) coef = coef * (n - i + 1) / i
    tail += coef
  }
  return Math.min(1, 2 * tail / 2 ** n)
}

/** Pairs needed to detect a `delta` log-ratio shift (α=.05 two-sided, power .8, Wilcoxon ARE ≥ .864). */
export function pairsNeeded(logRatios: readonly number[], delta = Math.log(1.2)): number {
  if (logRatios.length < 3) return NaN
  const mean = logRatios.reduce((a, b) => a + b, 0) / logRatios.length
  const variance = logRatios.reduce((a, b) => a + (b - mean) ** 2, 0) / (logRatios.length - 1)
  return Math.ceil(((1.96 + 0.8416) ** 2) * variance / (delta ** 2) / 0.864)
}

function main(): void {
  const file = process.argv[2]
  if (file === undefined) throw new Error('usage: bench-report.ts runs.jsonl [--baseline off]')
  const baselineIndex = process.argv.indexOf('--baseline')
  const baseline = baselineIndex > 0 ? process.argv[baselineIndex + 1] ?? 'off' : 'off'
  const rows = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Row)
  const tasks = [...new Set(rows.map(row => row.task))].sort()
  const conditions = [...new Set(rows.map(row => row.condition))].filter(c => c !== baseline).sort()
  const lines: string[] = []
  let confounded = false
  for (const task of tasks) {
    const base = new Map(rows.filter(r => r.task === task && r.condition === baseline).map(r => [r.block, r]))
    for (const condition of conditions) {
      const pairs = rows
        .filter(r => r.task === task && r.condition === condition && base.has(r.block))
        .map(r => [base.get(r.block) as Row, r] as const)
      if (pairs.length === 0) continue
      lines.push(`\n## ${task} — ${condition} vs ${baseline} (pairs=${pairs.length})`)
      for (const metric of METRICS) {
        const ratios = pairs.map(([b, c]) => Math.log(Math.max(c[metric], 1e-9) / Math.max(b[metric], 1e-9)))
        const medianRatio = Math.exp(median(ratios))
        const [lo, hi] = bootstrapMedianCi(ratios).map(Math.exp) as [number, number]
        const p = wilcoxon(ratios)
        const needed = pairsNeeded(ratios)
        const significant = p < 0.05
        if (condition === 'shadow' && significant && (metric === 'costUsd' || metric === 'steps')) confounded = true
        lines.push(
          `${metric.padEnd(16)} base=${median(pairs.map(([b]) => b[metric])).toPrecision(4).padStart(12)} ` +
          `this=${median(pairs.map(([, c]) => c[metric])).toPrecision(4).padStart(12)} ` +
          `ratio=${medianRatio.toFixed(3)} CI95=[${lo.toFixed(3)}, ${hi.toFixed(3)}] ` +
          `p=${Number.isNaN(p) ? 'n<6' : p.toFixed(4)} pairs-for-20%=${Number.isNaN(needed) ? '?' : needed}`,
        )
      }
      const b = pairs.filter(([x, y]) => x.success && !y.success).length
      const c = pairs.filter(([x, y]) => !x.success && y.success).length
      lines.push(`success          base=${pairs.filter(([x]) => x.success).length}/${pairs.length} this=${pairs.filter(([, y]) => y.success).length}/${pairs.length} McNemar p=${mcnemar(b, c).toFixed(4)}`)
      const waits = pairs.map(([, y]) => y.criticalWaitMs).filter((v): v is number => typeof v === 'number')
      if (waits.length > 0) lines.push(`criticalWaitMs   median=${median(waits).toFixed(0)} max=${Math.max(...waits).toFixed(0)}`)
    }
  }
  if (confounded) {
    lines.unshift('!! CONFOUNDED: shadow differs significantly from the baseline on cost/steps. Shadow cannot change behavior;',
      '!! randomize condition order per block, isolate sessions, report cache tokens, and re-run before trusting any result.')
  }
  console.log(lines.join('\n'))
}

if (process.argv[1]?.endsWith('bench-report.ts')) main()
