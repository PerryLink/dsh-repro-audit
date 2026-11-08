/**
 * Manifest construction, artifact mapping and drift comparison.
 *
 * A manifest is a hash of *what makes the project reproducible* — not a copy of
 * it. Artifacts map to REP `Artifact` records so a sealed report can bind a
 * claim to "this code, this lockfile, this data file, this seed".
 *
 * @module dsh-repro-audit/manifest
 */

import { sha256Hex, stableId, type Artifact } from '@perrylink/dsh-research-core'
import { scanProject, type ScanResult, type ScannedCommand, type ScannedFile, type ScannedSeed } from './scan.ts'
import { VERSION } from './version.ts'

/** Gap severities. */
export type GapSeverity = 'info' | 'warning' | 'error'

/** One reproducibility gap. */
export interface ReproGap {
  readonly code: string
  readonly severity: GapSeverity
  readonly detail: string
  readonly suggestion: string
}

/** Overall reproducibility level. */
export type ReproLevel = 'reproducible' | 'partial' | 'not_reproducible' | 'unknown'

/** Git evidence. */
export interface GitEvidence {
  readonly commit?: string
  readonly branch?: string
  readonly dirty?: boolean
  readonly error?: string
}

/** One artifact row in the manifest. */
export interface ManifestArtifact {
  readonly artifactId: string
  readonly kind: Artifact['kind']
  readonly path?: string
  readonly hash: string
  readonly description?: string
}

/** The reproducibility manifest. */
export interface ReproManifest {
  readonly manifestVersion: 1
  readonly generator: { readonly name: string; readonly version: string }
  readonly generatedAt: string
  readonly rootId: string
  readonly git: GitEvidence
  readonly runtimes: ScanResult['runtimes']
  readonly artifacts: readonly ManifestArtifact[]
  readonly seeds: readonly ScannedSeed[]
  readonly commands: readonly ScannedCommand[]
  readonly gaps: readonly ReproGap[]
  readonly level: ReproLevel
  readonly truncated: boolean
  readonly warnings: readonly string[]
}

/** Inputs for {@link buildManifest}. */
export interface BuildManifestInput {
  readonly rootId: string
  readonly generatedAt: string
  readonly scan: ScanResult
  readonly git: GitEvidence
}

/** Hash a plain string as a REP content address. */
function hashText(value: string): string {
  return `sha256:${sha256Hex(value)}`
}

/** Convert one scanned file into an artifact row. */
function fileArtifact(file: ScannedFile, kind: Artifact['kind'], description: string): ManifestArtifact | undefined {
  if (file.hash === undefined) return undefined
  return {
    artifactId: stableId('art', [kind, file.path]),
    kind,
    path: file.path,
    hash: file.hash,
    description,
  }
}

/** Derive gaps from a scan + git evidence. */
export function gapsOf(scan: ScanResult, git: GitEvidence): ReproGap[] {
  const gaps: ReproGap[] = []
  if (git.commit === undefined) {
    gaps.push({
      code: 'no_git_commit',
      severity: 'error',
      detail: git.error === undefined ? 'the project is not a git repository with a commit' : `git lookup failed: ${git.error}`,
      suggestion: 'commit the analysis code and record the commit hash',
    })
  }
  if (git.dirty === true) {
    gaps.push({
      code: 'dirty_worktree',
      severity: 'warning',
      detail: 'the working tree has uncommitted changes, so the recorded commit does not describe the files',
      suggestion: 'commit or stash changes before recording a manifest',
    })
  }
  if (scan.lockfiles.length === 0) {
    gaps.push({
      code: 'no_lockfile',
      severity: 'error',
      detail: 'no dependency lockfile was found (package-lock.json, pnpm-lock.yaml, renv.lock, requirements.txt, …)',
      suggestion: 'commit a lockfile so the dependency graph can be reconstructed',
    })
  }
  if (scan.commands.length === 0) {
    gaps.push({
      code: 'no_run_command',
      severity: 'error',
      detail: 'no runnable command was found (package.json scripts, Makefile targets, run/reproduce script)',
      suggestion: 'add a single documented entry point that regenerates the results',
    })
  }
  if (scan.seeds.length === 0 && scan.files.some(file => file.path.endsWith('.py') || file.path.endsWith('.R'))) {
    gaps.push({
      code: 'no_seed',
      severity: 'warning',
      detail: 'no random seed was found in the analysis scripts',
      suggestion: 'set and record an explicit seed (random_state, np.random.seed, set.seed, torch.manual_seed)',
    })
  }
  if (scan.data.length === 0) {
    gaps.push({
      code: 'no_data',
      severity: 'warning',
      detail: 'no data file was found in the project',
      suggestion: 'record where the input data comes from (a DOI, a repository, or a hashed copy)',
    })
  }
  if (scan.envFiles.length === 0 && scan.runtimes.node === undefined && scan.runtimes.python === undefined) {
    gaps.push({
      code: 'no_environment',
      severity: 'warning',
      detail: 'no runtime/environment pin was found (.nvmrc, .python-version, pyproject.toml, Dockerfile, …)',
      suggestion: 'pin the runtime version and, for compiled stacks, the toolchain',
    })
  }
  if (scan.figures.length === 0) {
    gaps.push({
      code: 'no_figures',
      severity: 'info',
      detail: 'no figure or table output was found',
      suggestion: 'record the script that produces each figure so the output can be regenerated',
    })
  }
  for (const file of scan.data.filter(item => item.hash === undefined)) {
    gaps.push({
      code: 'unhashed_data',
      severity: 'warning',
      detail: `data file not hashed: ${file.path} (${file.reason ?? 'unknown reason'})`,
      suggestion: 'reduce the file, hash it externally, or record its source identifier',
    })
  }
  if (scan.truncated) {
    gaps.push({
      code: 'scan_truncated',
      severity: 'warning',
      detail: 'the file cap was reached; the manifest does not cover the whole project',
      suggestion: 'raise maxFiles or audit a narrower directory',
    })
  }
  return gaps
}

/** Derive the level from gaps. */
export function levelOf(gaps: readonly ReproGap[]): ReproLevel {
  if (gaps.some(gap => gap.severity === 'error')) return 'not_reproducible'
  if (gaps.some(gap => gap.severity === 'warning')) return 'partial'
  return 'reproducible'
}

/**
 * Build a manifest from a scan and git evidence.
 * @param input - scan, git and identity.
 * @returns the manifest.
 */
export function buildManifest(input: BuildManifestInput): ReproManifest {
  const { scan, git } = input
  const artifacts: ManifestArtifact[] = []
  if (git.commit !== undefined) {
    artifacts.push({ artifactId: stableId('art', ['code', 'git']), kind: 'code', hash: hashText(`git:${git.commit}`), description: `git commit ${git.commit}` })
  }
  for (const file of scan.lockfiles) {
    const artifact = fileArtifact(file, 'env', 'dependency lockfile')
    if (artifact !== undefined) artifacts.push(artifact)
  }
  for (const file of scan.envFiles) {
    const artifact = fileArtifact(file, 'env', 'environment pin')
    if (artifact !== undefined) artifacts.push(artifact)
  }
  for (const file of scan.data) {
    const artifact = fileArtifact(file, 'data', 'input data')
    if (artifact !== undefined) artifacts.push(artifact)
  }
  for (const file of scan.figures) {
    const artifact = fileArtifact(file, 'figure', 'figure/table output')
    if (artifact !== undefined) artifacts.push(artifact)
  }
  for (const file of scan.notebooks) {
    const artifact = fileArtifact(file, 'notebook', 'notebook')
    if (artifact !== undefined) artifacts.push(artifact)
  }
  for (const seed of scan.seeds) {
    artifacts.push({
      artifactId: stableId('art', ['seed', seed.path, seed.line]),
      kind: 'seed',
      path: `${seed.path}:${seed.line}`,
      hash: hashText(`seed:${seed.path}:${seed.line}:${seed.value}`),
      description: `${seed.kind} = ${seed.value}`,
    })
  }
  for (const command of scan.commands) {
    artifacts.push({
      artifactId: stableId('art', ['command', command.source, command.name]),
      kind: 'command',
      hash: hashText(`command:${command.source}:${command.name}:${command.command}`),
      description: `${command.source}: ${command.name} → ${command.command}`,
    })
  }
  const gaps = gapsOf(scan, git)
  return {
    manifestVersion: 1,
    generator: { name: 'dsh-repro-audit', version: VERSION },
    generatedAt: input.generatedAt,
    rootId: input.rootId,
    git,
    runtimes: scan.runtimes,
    artifacts,
    seeds: scan.seeds,
    commands: scan.commands,
    gaps,
    level: levelOf(gaps),
    truncated: scan.truncated,
    warnings: scan.warnings,
  }
}

/** One drift between a stored manifest and the current tree. */
export interface DriftFinding {
  readonly artifactId: string
  readonly kind: Artifact['kind']
  readonly path?: string
  readonly status: 'missing' | 'changed' | 'added'
  readonly expected?: string
  readonly actual?: string
  readonly detail: string
}

/** The drift report. */
export interface DriftReport {
  readonly checkedAt: string
  readonly rootId: string
  readonly level: ReproLevel
  readonly findings: readonly DriftFinding[]
  readonly current: ReproManifest
}

/**
 * Re-scan a project and compare it with a stored manifest.
 * @param manifest - the stored manifest.
 * @param root - project root.
 * @param options - scan bounds + clock.
 * @returns the drift report.
 */
export async function compareManifest(
  manifest: ReproManifest,
  root: string,
  options: { generatedAt: string; scan?: ScanResult; git: GitEvidence },
): Promise<DriftReport> {
  const scan = options.scan ?? (await scanProject(root))
  const current = buildManifest({ rootId: manifest.rootId, generatedAt: options.generatedAt, scan, git: options.git })
  const findings: DriftFinding[] = []
  const currentById = new Map(current.artifacts.map(artifact => [artifact.artifactId, artifact]))
  for (const artifact of manifest.artifacts) {
    const match = currentById.get(artifact.artifactId)
    if (match === undefined) {
      findings.push({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        ...(artifact.path === undefined ? {} : { path: artifact.path }),
        status: 'missing',
        expected: artifact.hash,
        detail: `${artifact.kind} artifact is no longer present: ${artifact.path ?? artifact.description ?? artifact.artifactId}`,
      })
    } else if (match.hash !== artifact.hash) {
      findings.push({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        ...(artifact.path === undefined ? {} : { path: artifact.path }),
        status: 'changed',
        expected: artifact.hash,
        actual: match.hash,
        detail: `${artifact.kind} artifact changed: ${artifact.path ?? artifact.description ?? artifact.artifactId}`,
      })
    }
  }
  const storedIds = new Set(manifest.artifacts.map(artifact => artifact.artifactId))
  for (const artifact of current.artifacts) {
    if (storedIds.has(artifact.artifactId)) continue
    findings.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      ...(artifact.path === undefined ? {} : { path: artifact.path }),
      status: 'added',
      actual: artifact.hash,
      detail: `new ${artifact.kind} artifact since the manifest: ${artifact.path ?? artifact.description ?? artifact.artifactId}`,
    })
  }
  let level: ReproLevel = current.level
  if (findings.some(finding => finding.status === 'changed' || finding.status === 'missing')) level = 'not_reproducible'
  else if (findings.length > 0 && level === 'reproducible') level = 'partial'
  return { checkedAt: options.generatedAt, rootId: manifest.rootId, level, findings, current }
}
