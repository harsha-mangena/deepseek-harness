// Prints a human-readable summary of the benchmark manifest written by
// `pnpm run system1:bench`: totals, pass/fail, and the slowest test files.
// Usage: `pnpm run system1:report` from the repo root.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptsDir, '..', '..', '..')
const manifestPath = process.argv[2] ?? resolve(root, 'packages', 'system1', 'bench-manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`system1:report: no manifest at ${manifestPath}; run \`pnpm run system1:bench\` first`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const { totals, files = [] } = manifest
const failedFiles = files.filter((f) => f.failed > 0)
const slowest = [...files].sort((a, b) => b.durationMs - a.durationMs)

console.log(`System 1 benchmark report — ${manifest.timestamp}${manifest.gitRevision ? ` @ ${manifest.gitRevision}` : ''}`)
console.log(`Command: ${manifest.command}`)
console.log('')
console.log(`Totals: ${totals.passed}/${totals.tests} passed, ${totals.failed} failed, ` +
  `${totals.files} files, ${totals.durationMs} ms of test time`)
if (failedFiles.length > 0) {
  console.log('')
  console.log('Failed files:')
  for (const f of failedFiles) {
    console.log(`  FAIL ${f.file} (${f.failed}/${f.tests} failed)`)
  }
}
console.log('')
console.log('Slowest files:')
for (const f of slowest.slice(0, 10)) {
  const mark = f.failed > 0 ? 'FAIL' : 'ok  '
  console.log(`  ${mark} ${String(f.durationMs).padStart(9)} ms  ${f.file}`)
}
process.exit(totals.failed > 0 ? 1 : 0)
