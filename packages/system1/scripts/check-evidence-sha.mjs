// Exact-SHA gate for System 1 release evidence.
//
// Release evidence is only meaningful when it was generated at the exact
// commit being evaluated. This gate rejects stale evidence: it verifies that
// every generated artifact recording a git revision names the current HEAD
// as a full 40-character SHA. Regenerate evidence after each commit
// (`pnpm run system1:bench`) and update CERTIFICATION.md's phase table;
// do not hand-edit recorded SHAs.
//
// Usage: `node packages/system1/scripts/check-evidence-sha.mjs` from the repo
// root, or `pnpm run system1:check-evidence`. Exits 0 when every artifact is
// current, non-zero with a diagnostic otherwise.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const system1Dir = resolve(root, 'packages', 'system1')

const failures = []

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    failures.push('cannot determine HEAD: `git rev-parse HEAD` failed')
    return null
  }
}

const SHA_RE = /^[0-9a-f]{40}$/

function checkBenchManifest(head) {
  const path = resolve(system1Dir, 'bench-manifest.json')
  if (!existsSync(path)) {
    failures.push(`bench-manifest.json is missing; run \`pnpm run system1:bench\` at ${head}`)
    return
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    failures.push('bench-manifest.json is not valid JSON; regenerate with `pnpm run system1:bench`')
    return
  }
  const recorded = manifest.gitRevision
  if (typeof recorded !== 'string' || !SHA_RE.test(recorded)) {
    failures.push(
      `bench-manifest.json records ${JSON.stringify(recorded)}, not a full 40-character SHA; regenerate with \`pnpm run system1:bench\``,
    )
    return
  }
  if (recorded !== head) {
    failures.push(
      `bench-manifest.json is stale: recorded ${recorded}, HEAD is ${head}; regenerate with \`pnpm run system1:bench\``,
    )
  }
}

function checkCertification(head) {
  const path = resolve(system1Dir, 'CERTIFICATION.md')
  if (!existsSync(path)) {
    failures.push('CERTIFICATION.md is missing')
    return
  }
  const text = readFileSync(path, 'utf8')
  if (!text.includes(head)) {
    failures.push(
      `CERTIFICATION.md does not record HEAD ${head} in its phase table; update the exact-SHA table before release`,
    )
  }
}

const head = headSha()
if (head !== null) {
  if (!SHA_RE.test(head)) {
    failures.push(`HEAD ${JSON.stringify(head)} is not a full 40-character SHA`)
  } else {
    checkBenchManifest(head)
    checkCertification(head)
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`evidence-sha: ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`evidence-sha: release evidence is current at ${head}\n`)
