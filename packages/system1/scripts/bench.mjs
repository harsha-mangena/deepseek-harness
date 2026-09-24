// Runs the System 1 vitest suite with the JSON reporter and writes a
// benchmark manifest: per-file package, test counts, durations, plus a
// timestamp and the git revision. Usage: `pnpm run system1:bench` from the
// repo root. Exits non-zero when the suite fails.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptsDir, '..', '..', '..')
const system1Dir = resolve(root, 'packages', 'system1')
const manifestPath = resolve(system1Dir, 'bench-manifest.json')
const vitestBin = resolve(root, 'node_modules', '.bin', 'vitest')

/** Nearest ancestor package name for a test file, relative to the repo root. */
const packageCache = new Map()
function packageNameFor(absFile) {
  const start = dirname(absFile)
  const hit = packageCache.get(start)
  if (hit !== undefined) return hit
  const trail = []
  let dir = start
  while (dir.startsWith(root)) {
    const pkgPath = resolve(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name ?? '(unnamed)'
        for (const visited of [...trail, dir]) packageCache.set(visited, name)
        return name
      } catch {
        // Malformed package.json: keep walking up.
      }
    }
    trail.push(dir)
    dir = dirname(dir)
  }
  for (const visited of trail) packageCache.set(visited, '(unknown)')
  return '(unknown)'
}

function gitRevision() {
  return new Promise((resolveRev) => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }, (error, stdout) => {
      resolveRev(error ? null : stdout.trim())
    })
  })
}

function runVitest() {
  return new Promise((resolveRun) => {
    execFile(
      vitestBin,
      ['run', 'packages/system1/', '--reporter=json'],
      { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) process.stderr.write(stderr)
        const start = stdout.indexOf('{')
        let report = null
        try {
          report = start >= 0 ? JSON.parse(stdout.slice(start)) : null
        } catch {
          report = null
        }
        resolveRun({ code: error?.code ?? 0, report })
      },
    )
  })
}

const { code, report } = await runVitest()
if (!report || !Array.isArray(report.testResults)) {
  console.error('system1:bench: vitest did not emit a parseable JSON report')
  process.exit(code === 0 ? 1 : code)
}

const files = report.testResults.map((suite) => {
  const assertions = suite.assertionResults ?? []
  const durationMs = assertions.reduce((sum, a) => sum + (a.duration ?? 0), 0)
  return {
    package: packageNameFor(suite.name),
    file: relative(root, suite.name),
    tests: assertions.length,
    passed: assertions.filter((a) => a.status === 'passed').length,
    failed: assertions.filter((a) => a.status === 'failed').length,
    durationMs: Math.round(durationMs * 10) / 10,
  }
})
files.sort((a, b) => b.durationMs - a.durationMs)

const manifest = {
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  gitRevision: await gitRevision(),
  command: 'vitest run packages/system1/ --reporter=json',
  totals: {
    files: files.length,
    tests: report.numTotalTests ?? files.reduce((n, f) => n + f.tests, 0),
    passed: report.numPassedTests ?? files.reduce((n, f) => n + f.passed, 0),
    failed: report.numFailedTests ?? files.reduce((n, f) => n + f.failed, 0),
    durationMs: Math.round(files.reduce((n, f) => n + f.durationMs, 0) * 10) / 10,
  },
  files,
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
const { totals } = manifest
console.log(
  `system1:bench: ${totals.passed}/${totals.tests} passed across ${totals.files} files ` +
    `(${totals.durationMs} ms) -> ${relative(root, manifestPath)}`,
)
process.exit(code)
