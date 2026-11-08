#!/usr/bin/env node
// Benchmark adapter for the synthetic reproducibility-audit dataset.
//
// Each case in dsh-research-bench/data/repro/cases.jsonl is a recipe, not a
// fixture: a relative-path -> content map, a git mode, and a drift operation.
// This adapter materialises the recipe in a fresh mkdtemp, records a manifest
// with the plugin's public runtime, applies the drift to the tree, checks it,
// and scores the observed level, gap-code set and drift findings against the
// generator's hand-authored labels.
//
// Git is a hard prerequisite: the dataset's whole point is git evidence. If
// `git` is not on PATH the adapter exits with code 2 instead of pretending the
// cases passed. Fixture git commands are isolated from the host's git
// configuration (empty GIT_CONFIG_GLOBAL, no system config) and use the fixed
// identity fixture@example.invalid.
//
// Writes bench/results-repro.json and bench/results-repro.md. Both are
// deterministic: no timestamps, no temp paths, no commit hashes.
//
// Usage: node bench/run-repro.mjs [--data <dir>]
// Default data: ../dsh-research-bench/data/repro (sibling checkout). BENCH_DIR
// may point at the benchmark repository root or directly at data/repro.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'bench')
const projectDirectory = 'project'
const fixtureGitUser = 'fixture@example.invalid'
const fixedNow = '2026-01-01T00:00:00.000Z'

const LEVELS = ['reproducible', 'partial', 'not_reproducible']
const GIT_MODES = ['none', 'commit', 'dirty', 'commit-then-modify']
const GAP_CODES = [
  'no_git_commit',
  'dirty_worktree',
  'no_lockfile',
  'no_run_command',
  'no_seed',
  'no_data',
  'no_environment',
  'unhashed_data',
  'no_figures',
  'scan_truncated',
]
const GAP_ORDER = new Map(GAP_CODES.map((code, index) => [code, index]))
const ERROR_CODES = new Set(['no_git_commit', 'no_lockfile', 'no_run_command'])
const WARNING_CODES = new Set(['dirty_worktree', 'no_seed', 'no_data', 'no_environment', 'unhashed_data', 'scan_truncated'])

const fail = (message, code = 1) => {
  console.error(`bench:repro: ${message}`)
  process.exit(code)
}

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${file}: ${error.message}`)
  }
}

const readJsonl = file => {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`${file}: ${error.message}`)
  }
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        const value = JSON.parse(line)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          fail(`${file}:${index + 1}: each line must be a JSON object`)
        }
        return value
      } catch (error) {
        fail(`${file}:${index + 1}: ${error.message}`)
      }
    })
}

// ── arguments and dataset location ──────────────────────────────────────────

const defaultBenchRoot = path.resolve(root, '..', 'dsh-research-bench')
let benchRoot = process.env.BENCH_DIR === undefined ? defaultBenchRoot : path.resolve(process.env.BENCH_DIR)
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--help' || argument === '-h') {
    console.log('usage: node bench/run-repro.mjs [--data <dir>]')
    process.exit(0)
  }
  if (argument === '--data') {
    const value = argv[index + 1]
    if (value === undefined) fail('--data needs a directory')
    benchRoot = path.resolve(value)
    index += 1
    continue
  }
  fail(`unknown argument ${argument}`)
}

const nested = path.join(benchRoot, 'data', 'repro')
const dataDir = existsSync(path.join(nested, 'cases.jsonl')) ? nested : benchRoot
const casesFile = path.join(dataDir, 'cases.jsonl')
const summaryFile = path.join(dataDir, 'SUMMARY.json')
const schemaFile = path.join(dataDir, 'schema.json')
for (const file of [casesFile, summaryFile, schemaFile]) {
  if (!existsSync(file)) {
    fail(
      `missing ${file}; generate it with \`node ../dsh-research-bench/scripts/generate-repro.mjs\` ` +
        'or set BENCH_DIR / pass --data <dir>',
    )
  }
}

const summary = readJson(summaryFile)
const schema = readJson(schemaFile)
const cases = readJsonl(casesFile)
const packageJson = readJson(path.join(root, 'package.json'))

const EXPECTED_CASES = 10
if (cases.length !== EXPECTED_CASES) fail(`expected ${EXPECTED_CASES} recipe cases, found ${cases.length}`)
if (summary.dataset !== 'repro') fail(`SUMMARY.dataset is ${String(summary.dataset)}, expected "repro"`)
if (summary.synthetic !== true) fail('SUMMARY must declare synthetic: true')
if (typeof summary.version !== 'string' || summary.version === '') fail('SUMMARY.version must be a non-empty string')
if (summary.total !== cases.length) fail(`SUMMARY.total is ${String(summary.total)}, cases file has ${cases.length}`)
if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('data/repro/schema.json is not JSON Schema 2020-12')
if (!Array.isArray(summary.labelSpace?.category) || !Array.isArray(summary.labelSpace?.git) || !Array.isArray(summary.labelSpace?.drift)) {
  fail('SUMMARY.labelSpace must declare category, git and drift')
}

// ── validate the recipe independently of the generator ──────────────────────

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

const isSafeRelative = value => {
  if (typeof value !== 'string' || value === '' || value.includes('\\')) return false
  if (path.posix.isAbsolute(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

const parseDrift = value => {
  if (value === 'none') return { operation: 'none', target: null }
  const separator = value.indexOf(':')
  if (separator < 0) return { operation: value, target: null }
  return { operation: value.slice(0, separator), target: value.slice(separator + 1) }
}

const levelForGaps = codes => {
  if (codes.some(code => ERROR_CODES.has(code))) return 'not_reproducible'
  if (codes.some(code => WARNING_CODES.has(code))) return 'partial'
  return 'reproducible'
}

const sortGaps = codes => [...codes].sort((left, right) => GAP_ORDER.get(left) - GAP_ORDER.get(right))

const expectedFindingsOf = item => {
  const drift = parseDrift(item.drift)
  if (drift.operation === 'none') return []
  return [{ status: drift.operation === 'modify' ? 'changed' : 'missing', path: drift.target }]
}

const ids = new Set()
for (const [index, item] of cases.entries()) {
  const where = `cases.jsonl:${index + 1}`
  if (typeof item.id !== 'string' || !/^repro-[0-9]{4}$/u.test(item.id)) fail(`${where}: bad id ${String(item.id)}`)
  if (ids.has(item.id)) fail(`${where}: duplicate id ${item.id}`)
  ids.add(item.id)
  if (!summary.labelSpace.category.includes(item.category)) fail(`${where}: unknown category ${String(item.category)}`)
  if (typeof item.description !== 'string' || item.description === '') fail(`${where}: description missing`)
  if (!isObject(item.files) || Object.keys(item.files).length === 0) fail(`${where}: files must be a non-empty object`)
  for (const [relative, content] of Object.entries(item.files)) {
    if (!isSafeRelative(relative)) fail(`${where}: unsafe file path ${JSON.stringify(relative)}`)
    if (relative.split('/').includes('.git')) fail(`${where}: recipes must not contain .git paths`)
    if (typeof content !== 'string' || content.length === 0) fail(`${where}: file ${relative} must be a non-empty string`)
  }
  if (!GIT_MODES.includes(item.git)) fail(`${where}: unknown git mode ${String(item.git)}`)
  if (!isObject(item.expected)) fail(`${where}: expected missing`)
  if (!LEVELS.includes(item.expected.level)) fail(`${where}: bad expected.level ${String(item.expected.level)}`)
  if (!Array.isArray(item.expected.gaps)) fail(`${where}: expected.gaps must be an array`)
  if (new Set(item.expected.gaps).size !== item.expected.gaps.length) fail(`${where}: duplicate expected gap code`)
  for (const code of item.expected.gaps) {
    if (!GAP_CODES.includes(code)) fail(`${where}: unknown expected gap code ${String(code)}`)
  }
  if (levelForGaps(item.expected.gaps) !== item.expected.level) fail(`${where}: expected.level disagrees with gap severities`)

  if (item.git === 'none') {
    if (!item.expected.gaps.includes('no_git_commit')) fail(`${where}: git none must expect no_git_commit`)
  } else if (item.expected.gaps.includes('no_git_commit')) {
    fail(`${where}: a committed fixture must not expect no_git_commit`)
  }
  if (item.git === 'dirty' || item.git === 'commit-then-modify') {
    if (!item.expected.gaps.includes('dirty_worktree')) fail(`${where}: a dirty fixture must expect dirty_worktree`)
  } else if (item.expected.gaps.includes('dirty_worktree')) {
    fail(`${where}: a clean fixture must not expect dirty_worktree`)
  }
  if (item.git === 'commit-then-modify' && item.files['analysis.py'] === undefined) {
    fail(`${where}: commit-then-modify needs analysis.py`)
  }
  if (item.git === 'dirty' && item.files['notes.txt'] !== undefined) {
    fail(`${where}: dirty adds notes.txt itself, so the recipe must not contain it`)
  }

  const drift = parseDrift(item.drift)
  if (drift.operation !== 'none' && drift.operation !== 'modify' && drift.operation !== 'delete') {
    fail(`${where}: unknown drift operation in ${String(item.drift)}`)
  }
  if (drift.operation === 'none') {
    if (item.drift !== 'none') fail(`${where}: malformed drift value ${String(item.drift)}`)
  } else if (drift.target === null || !isSafeRelative(drift.target) || item.files[drift.target] === undefined) {
    fail(`${where}: drift target ${String(drift.target)} is not a safe recipe file`)
  }
}

const countBy = (items, pick) => {
  const counts = {}
  for (const item of items) {
    const key = pick(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const sameCounts = (left, right) => {
  const entries = value => Object.entries(value ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right))
}

const categories = summary.labelSpace.category
const byCategory = Object.fromEntries(categories.map(category => [category, 0]))
for (const item of cases) byCategory[item.category] += 1
const byLevel = Object.fromEntries(LEVELS.map(level => [level, 0]))
for (const item of cases) byLevel[item.expected.level] += 1
const byGit = Object.fromEntries(GIT_MODES.map(mode => [mode, 0]))
for (const item of cases) byGit[item.git] += 1
const byDrift = { none: 0, modify: 0, delete: 0 }
for (const item of cases) byDrift[parseDrift(item.drift).operation] += 1

if (summary.byCategory !== undefined && !sameCounts(summary.byCategory, byCategory)) fail('SUMMARY.byCategory disagrees with cases.jsonl')
if (summary.byLevel !== undefined && !sameCounts(summary.byLevel, byLevel)) fail('SUMMARY.byLevel disagrees with cases.jsonl')
if (summary.byGit !== undefined && !sameCounts(summary.byGit, byGit)) fail('SUMMARY.byGit disagrees with cases.jsonl')
if (summary.byDrift !== undefined && !sameCounts(summary.byDrift, byDrift)) fail('SUMMARY.byDrift disagrees with cases.jsonl')

// ── load the built plugin ───────────────────────────────────────────────────

const libFile = path.join(root, 'lib', 'index.js')
if (!existsSync(libFile)) fail('lib/index.js is missing; run `pnpm run build` first')
let ReproAuditRuntime
let resolveConfig
try {
  ;({ ReproAuditRuntime, resolveConfig } = await import(pathToFileURL(libFile).href))
} catch (error) {
  fail(`cannot load lib/index.js (${error.message}); run \`pnpm run build\` first`)
}
if (typeof ReproAuditRuntime !== 'function' || typeof resolveConfig !== 'function') {
  fail('lib/index.js does not export ReproAuditRuntime/resolveConfig')
}

// ── git helpers ─────────────────────────────────────────────────────────────

try {
  await execFileAsync('git', ['--version'], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 })
} catch (error) {
  fail(
    `git is required by the repro benchmark but was not found on PATH (${error.message}). ` +
      'Install git (on Windows: Git for Windows) and re-run.',
    2,
  )
}

const temporaryRoot = path.resolve(tmpdir())
const isTemporary = value => {
  const relative = path.relative(temporaryRoot, value)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function removeTemporary(base) {
  if (!isTemporary(base)) throw new Error(`refusing to remove a path outside ${temporaryRoot}: ${base}`)
  await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

function gitEnvironment(gitConfigFile) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = gitConfigFile
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

async function git(project, env, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', project, ...args], {
      env,
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const detail = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

async function prepareGit(item, project, env, base) {
  if (item.git === 'none') {
    if (existsSync(path.join(project, '.git'))) throw new Error('git:none fixture unexpectedly contains .git')
    return
  }
  // The runtime's read-only git calls use the host's global config. Locally
  // override the keys that could change what `git status` reports: line-ending
  // conversion, untracked-file visibility and a user/global excludes file.
  const emptyExcludes = path.join(base, 'empty-excludes')
  await writeFile(emptyExcludes, '', 'utf8')
  await git(project, env, ['init', '-q'])
  await git(project, env, ['config', 'user.name', 'Repro Fixture'])
  await git(project, env, ['config', 'user.email', fixtureGitUser])
  await git(project, env, ['config', 'commit.gpgsign', 'false'])
  await git(project, env, ['config', 'core.autocrlf', 'false'])
  await git(project, env, ['config', 'core.safecrlf', 'false'])
  await git(project, env, ['config', 'core.fsmonitor', 'false'])
  await git(project, env, ['config', 'core.excludesFile', emptyExcludes])
  await git(project, env, ['config', 'status.showUntrackedFiles', 'all'])
  await git(project, env, ['add', '--all'])
  await git(project, env, ['commit', '-q', '--no-gpg-sign', '-m', 'fixture'])

  if (item.git === 'dirty') {
    await writeFile(path.join(project, 'notes.txt'), 'uncommitted note\n', 'utf8')
  } else if (item.git === 'commit-then-modify') {
    await appendFile(path.join(project, 'analysis.py'), '\n# local uncommitted edit\n', 'utf8')
  }

  const status = (await git(project, env, ['status', '--porcelain'])).trim()
  if (item.git === 'commit' && status !== '') throw new Error(`commit fixture is dirty after commit: ${status}`)
  if ((item.git === 'dirty' || item.git === 'commit-then-modify') && status === '') {
    throw new Error(`${item.git} fixture did not leave a dirty worktree`)
  }
}

// ── per-case execution ──────────────────────────────────────────────────────

const findingKey = finding => `${finding.status}:${finding.path ?? ''}`
const matchesFinding = (finding, expected) => finding.status === expected.status && finding.path === expected.path
const serialiseFinding = finding => ({
  status: finding.status,
  kind: finding.kind,
  ...(finding.path === undefined ? {} : { path: finding.path }),
})

const perCase = []
const cleanupWarnings = []

for (const item of cases) {
  let base
  try {
    base = await mkdtemp(path.join(tmpdir(), 'dsh-repro-bench-'))
    if (!isTemporary(base)) throw new Error(`mkdtemp returned a path outside ${temporaryRoot}: ${base}`)
    const project = path.join(base, projectDirectory)
    const store = path.join(base, 'store')
    const gitConfigFile = path.join(base, 'gitconfig')
    await mkdir(project, { recursive: true })
    await writeFile(gitConfigFile, '', 'utf8')

    for (const [relative, content] of Object.entries(item.files)) {
      const absolute = path.join(project, ...relative.split('/'))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
    }

    const env = gitEnvironment(gitConfigFile)
    await prepareGit(item, project, env, base)

    const runtime = new ReproAuditRuntime({
      config: resolveConfig({ root: store, workspaceRoot: base }),
      now: () => new Date(fixedNow),
    })
    const { manifest } = await runtime.manifest({ path: projectDirectory })

    if (item.git === 'none') {
      if (manifest.git.commit !== undefined) throw new Error('git:none fixture unexpectedly has a commit')
      if (manifest.git.dirty === true) throw new Error('git:none fixture unexpectedly reports a dirty worktree')
    } else {
      if (typeof manifest.git.commit !== 'string' || manifest.git.commit === '') throw new Error('fixture has no git commit')
      if (item.git === 'commit' && manifest.git.dirty === true) throw new Error('commit fixture reports a dirty worktree')
      if ((item.git === 'dirty' || item.git === 'commit-then-modify') && manifest.git.dirty !== true) {
        throw new Error(`${item.git} fixture does not report a dirty worktree`)
      }
    }

    const drift = parseDrift(item.drift)
    if (drift.operation === 'modify') {
      await appendFile(path.join(project, ...drift.target.split('/')), '\n', 'utf8')
    } else if (drift.operation === 'delete') {
      await rm(path.join(project, ...drift.target.split('/')))
    }

    const report = await runtime.check({ manifest, path: projectDirectory })
    const findings = report.findings.map(serialiseFinding)
    const expectedFindings = expectedFindingsOf(item)
    const expectedGaps = sortGaps(item.expected.gaps)
    const actualGaps = manifest.gaps.map(gap => gap.code)
    const actualSet = new Set(actualGaps)
    const expectedSet = new Set(expectedGaps)
    const missingGaps = expectedGaps.filter(code => !actualSet.has(code))
    const extraGaps = actualGaps.filter(code => !expectedSet.has(code))
    const truePositives = expectedGaps.filter(code => actualSet.has(code)).length
    const gapsExact = missingGaps.length === 0 && extraGaps.length === 0
    const levelMatch = manifest.level === item.expected.level
    const matchedExpectedFindings = expectedFindings.filter(expected => findings.some(finding => matchesFinding(finding, expected)))
    const unexpectedFindings = findings.filter(finding => !expectedFindings.some(expected => matchesFinding(finding, expected)))
    const missingFindings = expectedFindings.filter(expected => !findings.some(finding => matchesFinding(finding, expected)))
    const driftDetected = findings.length > 0
    const driftTargetMatched = expectedFindings.length > 0 && missingFindings.length === 0
    const driftExact = unexpectedFindings.length === 0 && missingFindings.length === 0 && findings.length === expectedFindings.length
    const falsePositive = item.drift === 'none' && findings.length > 0

    const reasons = []
    if (!levelMatch) reasons.push(`level ${manifest.level} != expected ${item.expected.level}`)
    if (!gapsExact) {
      const details = []
      if (missingGaps.length > 0) details.push(`missing gaps: ${missingGaps.join(', ')}`)
      if (extraGaps.length > 0) details.push(`extra gaps: ${extraGaps.join(', ')}`)
      reasons.push(`gap set differs (${details.join('; ')})`)
    }
    if (item.drift === 'none' && findings.length > 0) {
      reasons.push(`unexpected drift findings: ${findings.map(findingKey).join(', ')}`)
    }
    if (item.drift !== 'none' && !driftExact) {
      const expectedText = expectedFindings.map(findingKey).join(', ') || '(none)'
      const actualText = findings.map(findingKey).join(', ') || '(none)'
      reasons.push(`drift findings ${actualText} != expected ${expectedText}`)
    }

    perCase.push({
      id: item.id,
      category: item.category,
      git: item.git,
      drift: item.drift,
      expected: {
        level: item.expected.level,
        gaps: expectedGaps,
        findings: expectedFindings,
      },
      actual: {
        level: manifest.level,
        gaps: actualGaps,
        checkLevel: report.level,
        findings,
      },
      levelMatch,
      gapsExact,
      missingGaps,
      extraGaps,
      gapPrecision: actualGaps.length === 0 ? (expectedGaps.length === 0 ? 1 : 0) : truePositives / actualGaps.length,
      gapRecall: expectedGaps.length === 0 ? 1 : truePositives / expectedGaps.length,
      driftExpected: expectedFindings.length > 0,
      driftDetected,
      driftTargetMatched,
      driftExact,
      matchedExpectedFindings: matchedExpectedFindings.length,
      unexpectedFindings,
      falsePositive,
      pass: reasons.length === 0,
      ...(reasons.length === 0 ? {} : { reasons }),
    })
  } catch (error) {
    const expectedGaps = sortGaps(item.expected.gaps)
    const expectedFindings = expectedFindingsOf(item)
    perCase.push({
      id: item.id,
      category: item.category,
      git: item.git,
      drift: item.drift,
      expected: { level: item.expected.level, gaps: expectedGaps, findings: expectedFindings },
      actual: null,
      levelMatch: false,
      gapsExact: false,
      missingGaps: expectedGaps,
      extraGaps: [],
      gapPrecision: 0,
      gapRecall: 0,
      driftExpected: expectedFindings.length > 0,
      driftDetected: false,
      driftTargetMatched: false,
      driftExact: false,
      matchedExpectedFindings: 0,
      unexpectedFindings: [],
      falsePositive: false,
      pass: false,
      reasons: [`error: ${error instanceof Error ? error.message : String(error)}`],
    })
  } finally {
    if (base !== undefined) {
      try {
        await removeTemporary(base)
      } catch (error) {
        cleanupWarnings.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

// ── metrics ─────────────────────────────────────────────────────────────────

const total = perCase.length
const passed = perCase.filter(item => item.pass).length
const failed = total - passed
const levelMatched = perCase.filter(item => item.levelMatch).length

let gapTruePositives = 0
let gapFalsePositives = 0
let gapFalseNegatives = 0
for (const item of perCase) {
  // An errored case has no observed gap set; count every expected code as a
  // miss instead of quietly dropping the case from the denominator.
  const actualGaps = item.actual === null ? [] : item.actual.gaps
  const actualSet = new Set(actualGaps)
  const expectedSet = new Set(item.expected.gaps)
  gapTruePositives += item.expected.gaps.filter(code => actualSet.has(code)).length
  gapFalsePositives += actualGaps.filter(code => !expectedSet.has(code)).length
  gapFalseNegatives += item.expected.gaps.filter(code => !actualSet.has(code)).length
}
const actualGapTotal = gapTruePositives + gapFalsePositives
const expectedGapTotal = gapTruePositives + gapFalseNegatives
const gapPrecision = actualGapTotal === 0 ? (expectedGapTotal === 0 ? 1 : 0) : gapTruePositives / actualGapTotal
const gapRecall = expectedGapTotal === 0 ? 1 : gapTruePositives / expectedGapTotal
const gapF1 = gapPrecision + gapRecall === 0 ? 0 : (2 * gapPrecision * gapRecall) / (gapPrecision + gapRecall)

const driftCases = perCase.filter(item => item.drift !== 'none')
const driftDetected = driftCases.filter(item => item.driftDetected).length
const driftExact = driftCases.filter(item => item.driftExact).length
const cleanCases = perCase.filter(item => item.drift === 'none')
const cleanErrored = cleanCases.filter(item => item.actual === null).length
const falsePositiveCases = cleanCases.filter(item => item.actual !== null && item.actual.findings.length > 0).length
const noFalsePositive = cleanCases.length - falsePositiveCases - cleanErrored
const gapsExactCases = perCase.filter(item => item.gapsExact).length

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator)

const results = {
  dataset: summary.dataset,
  datasetVersion: summary.version,
  plugin: { name: packageJson.name, version: packageJson.version },
  command: 'pnpm run bench:repro',
  call: 'ReproAuditRuntime.manifest({ path: "project" }) then ReproAuditRuntime.check({ manifest, path: "project" })',
  fixture: {
    gitUser: fixtureGitUser,
    workspace: 'one fresh mkdtemp per case; project in <temp>/project and records in <temp>/store',
    drift: 'modify appends one LF to the recorded file after the manifest; delete removes the recorded file',
    gitIsolation: 'GIT_CONFIG_GLOBAL points at an empty file; GIT_CONFIG_NOSYSTEM=1; GIT_* is stripped',
  },
  cases: total,
  passed,
  failed,
  passRate: passed / total,
  metrics: {
    levelAccuracy: { matched: levelMatched, total, rate: levelMatched / total },
    gapPrecision: { truePositives: gapTruePositives, falsePositives: gapFalsePositives, precision: gapPrecision },
    gapRecall: { truePositives: gapTruePositives, falseNegatives: gapFalseNegatives, recall: gapRecall },
    gapF1,
    gapExactSet: { matched: gapsExactCases, total, rate: gapsExactCases / total },
    driftDetection: { detected: driftDetected, total: driftCases.length, rate: ratio(driftDetected, driftCases.length) },
    driftExact: { matched: driftExact, total: driftCases.length, rate: ratio(driftExact, driftCases.length) },
    noFalsePositive: {
      cleanCases: noFalsePositive,
      total: cleanCases.length,
      falsePositiveCases,
      rate: ratio(noFalsePositive, cleanCases.length),
    },
    casesPassed: { passed, total, rate: passed / total },
  },
  definitions: {
    levelAccuracy: 'manifest.level === expected.level at record time; drift cases are scored separately',
    gapPrecision: 'micro-averaged over all cases: TP / (TP + FP) on gap-code sets; an errored case has no observed codes',
    gapRecall: 'micro-averaged over all cases: TP / (TP + FN) on gap-code sets; an errored case misses its expected codes',
    gapExactSet: 'every expected gap code is present and no extra gap code is reported',
    driftDetection: 'findings.length > 0 on cases whose drift is not none',
    driftExact: 'findings match the expected status/path set exactly',
    noFalsePositive: 'findings.length === 0 on cases whose drift is none',
  },
  distribution: { byCategory, byLevel, byGit, byDrift },
  failures: perCase.filter(item => !item.pass).map(item => ({ id: item.id, reasons: item.reasons ?? [] })),
  perCase,
}

// ── markdown ────────────────────────────────────────────────────────────────

const percent = value => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`)
const codeList = codes => (codes.length === 0 ? '—' : codes.join(', '))

const gapStatus = item => {
  if (item.actual === null) return 'error'
  if (item.gapsExact) return 'exact'
  const details = []
  if (item.missingGaps.length > 0) details.push(`missing ${item.missingGaps.join(', ')}`)
  if (item.extraGaps.length > 0) details.push(`extra ${item.extraGaps.join(', ')}`)
  return details.join('; ')
}

const driftStatus = item => {
  if (item.actual === null) return 'error'
  if (item.drift === 'none') return item.actual.findings.length === 0 ? 'clean' : `false positive (${item.actual.findings.length})`
  const expected = item.expected.findings.map(finding => `${finding.status} ${finding.path}`).join(', ')
  return item.driftExact ? `exact: ${expected}` : `inexact (expected ${expected})`
}

const categoryRows = categories.map(category => `| \`${category}\` | ${byCategory[category]} |`)
const gitRows = GIT_MODES.map(mode => `| \`${mode}\` | ${byGit[mode]} |`)
const driftRows = ['none', 'modify', 'delete'].map(operation => `| \`${operation}\` | ${byDrift[operation]} |`)
const levelRows = LEVELS.map(level => `| \`${level}\` | ${byLevel[level]} |`)
const caseRows = perCase.map(item => {
  const actualLevel = item.actual === null ? 'error' : item.actual.level
  const expectedGaps = codeList(item.expected.gaps)
  const actualGaps = item.actual === null ? '—' : codeList(item.actual.gaps)
  return `| \`${item.id}\` | ${item.category} | ${item.git} | ${item.drift} | ${item.expected.level} | ${actualLevel} | ${expectedGaps} | ${actualGaps} | ${gapStatus(item)} | ${driftStatus(item)} | ${item.pass ? 'yes' : '**NO**'} |`
})

const failureSection =
  results.failures.length === 0
    ? ''
    : ['', '## Failures', '', ...results.failures.map(failure => `- \`${failure.id}\`: ${failure.reasons.join('; ')}`), ''].join('\n')

const markdown = [
  '# dsh-repro-audit benchmark: repro',
  '',
  `- Dataset: \`${summary.dataset}\` v${summary.version} (${total} synthetic recipe cases)`,
  `- Plugin: \`${packageJson.name}\` v${packageJson.version}`,
  `- Call: \`ReproAuditRuntime.manifest({ path: "project" })\` then \`ReproAuditRuntime.check({ manifest, path: "project" })\``,
  '- Command: `pnpm run bench:repro`',
  `- Fixtures: one fresh \`mkdtemp\` per case; git identity \`${fixtureGitUser}\`; drift applied after the manifest`,
  `- Cases passed: **${passed}/${total} (${percent(passed / total)})**`,
  '',
  '## Metrics',
  '',
  '| Metric | Result |',
  '|---|---|',
  `| Level accuracy (manifest, record time) | ${levelMatched}/${total} (${percent(levelMatched / total)}) |`,
  `| Gap precision (micro) | ${gapTruePositives} TP / ${gapFalsePositives} FP = ${gapPrecision.toFixed(3)} |`,
  `| Gap recall (micro) | ${gapTruePositives} TP / ${gapFalseNegatives} FN = ${gapRecall.toFixed(3)} |`,
  `| Gap F1 | ${gapF1.toFixed(3)} |`,
  `| Exact gap set | ${gapsExactCases}/${total} (${percent(gapsExactCases / total)}) |`,
  `| Drift detection | ${driftDetected}/${driftCases.length} (${percent(ratio(driftDetected, driftCases.length))}) |`,
  `| Exact drift finding | ${driftExact}/${driftCases.length} (${percent(ratio(driftExact, driftCases.length))}) |`,
  `| No false positives | ${noFalsePositive}/${cleanCases.length} (${percent(ratio(noFalsePositive, cleanCases.length))}) |`,
  `| Cases passed | ${passed}/${total} (${percent(passed / total)}) |`,
  '',
  '`expected.gaps` is an exact hand-authored code set, not a superset tolerance. Level accuracy compares the',
  'manifest level at record time; the drift score is separate. `modify` appends one LF to the recorded file',
  'after the manifest; `delete` removes it.',
  '',
  '## Distribution',
  '',
  '| Category | Cases |',
  '|---|---:|',
  ...categoryRows,
  '',
  '| git mode | Cases |',
  '|---|---:|',
  ...gitRows,
  '',
  '| drift | Cases |',
  '|---|---:|',
  ...driftRows,
  '',
  '| expected level | Cases |',
  '|---|---:|',
  ...levelRows,
  '',
  '## Cases',
  '',
  '| Case | Category | git | drift | Expected level | Actual level | Expected gaps | Actual gaps | Gap set | Drift | Pass |',
  '|---|---|---|---|---|---|---|---|---|---|:---:|',
  ...caseRows,
  failureSection,
].join('\n')

mkdirSync(outputDir, { recursive: true })
writeFileSync(path.join(outputDir, 'results-repro.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
writeFileSync(path.join(outputDir, 'results-repro.md'), markdown, 'utf8')

console.log(markdown)
if (cleanupWarnings.length > 0) {
  for (const warning of cleanupWarnings) console.error(`bench:repro: cleanup warning: ${warning}`)
}
console.log(`bench:repro: ${passed}/${total} cases passed; wrote bench/results-repro.json and bench/results-repro.md`)
if (failed > 0) process.exitCode = 1
