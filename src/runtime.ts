/**
 * Runtime: path safety, read-only git evidence, manifest persistence.
 *
 * `git rev-parse` / `git status --porcelain` are the only subprocesses started,
 * with a short timeout and no shell. Project code is never executed.
 *
 * @module dsh-repro-audit/runtime
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { stableId, validateRep, type ResearchRecord } from '@perrylink/dsh-research-core'
import type { ResolvedConfig } from './config.ts'
import { buildManifest, compareManifest, type DriftReport, type GitEvidence, type ReproManifest } from './manifest.ts'
import { isInside, scanProject, type ScanOptions } from './scan.ts'
import { VERSION } from './version.ts'

const execFileAsync = promisify(execFile)

/** Stable error codes. */
export type ReproErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'PATH_ESCAPE' | 'NOT_A_DIRECTORY' | 'INVALID_MANIFEST' | 'STORE_ERROR'

/** A typed failure. */
export class ReproError extends Error {
  /** Stable code. */
  readonly code: ReproErrorCode

  constructor(code: ReproErrorCode, message: string) {
    super(message)
    this.name = 'ReproError'
    this.code = code
  }
}

/** Result of `repro_manifest`. */
export interface ManifestResult {
  readonly manifest: ReproManifest
  readonly recordPath: string
}

/** Options for {@link ReproAuditRuntime}. */
export interface ReproAuditRuntimeOptions {
  readonly config: ResolvedConfig
  readonly now?: () => Date
}

/** True when `value` is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when `value` is a manifest this plugin can compare without crashing. */
function isManifest(value: unknown): value is ReproManifest {
  if (!isRecord(value)) return false
  if (value['manifestVersion'] !== 1 || !Array.isArray(value['artifacts'])) return false
  if (typeof value['rootId'] !== 'string' || typeof value['generatedAt'] !== 'string') return false
  if (!Array.isArray(value['gaps']) || !Array.isArray(value['warnings']) || !Array.isArray(value['seeds']) || !Array.isArray(value['commands'])) return false
  return value['artifacts'].every(artifact => isRecord(artifact)
    && typeof artifact['artifactId'] === 'string'
    && typeof artifact['kind'] === 'string'
    && typeof artifact['hash'] === 'string')
}

/** Read git evidence without executing project code. */
export async function gitEvidence(root: string): Promise<GitEvidence> {
  const run = async (args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // `git status` may otherwise refresh/write the index, and a repo-local
        // fsmonitor hook is an arbitrary command; disable both.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
      return stdout.trim()
    } catch {
      return undefined
    }
  }
  const commit = await run(['rev-parse', 'HEAD'])
  if (commit === undefined) return { error: 'not a git repository or no commit' }
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await run(['status', '--porcelain'])
  return {
    commit,
    ...(branch === undefined || branch === 'HEAD' ? {} : { branch }),
    dirty: status !== undefined && status !== '',
  }
}

/** The runtime. */
export class ReproAuditRuntime {
  readonly config: ResolvedConfig
  readonly #now: () => Date

  constructor(options: ReproAuditRuntimeOptions) {
    this.config = options.config
    this.#now = options.now ?? (() => new Date())
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** Scan bounds plus an exclusion for the record store when it is inside the project. */
  #scanOptions(root: string): ScanOptions {
    // If root IS the project, only the generated records/ directory can be
    // excluded; excluding the project root would scan nothing.
    const ignore = this.config.root === root ? path.join(this.config.root, 'records') : this.config.root
    const inside = ignore !== root && isInside(root, ignore)
    return {
      maxFiles: this.config.maxFiles,
      maxDepth: this.config.maxDepth,
      maxFileBytes: this.config.maxFileBytes,
      ...(inside ? { ignorePaths: [ignore] } : {}),
    }
  }

  /** Resolve a project directory inside the workspace. */
  async resolveDirectory(input?: string): Promise<{ absolute: string; id: string }> {
    const root = this.config.workspaceRoot
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      throw new ReproError('NOT_FOUND', `workspace root does not exist: ${root}`)
    }
    const candidate = path.resolve(realRoot, input ?? '.')
    if (!isInside(realRoot, candidate)) throw new ReproError('PATH_ESCAPE', 'path resolves outside the workspace root')
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      throw new ReproError('NOT_FOUND', `project directory not found: ${input ?? '.'}`)
    }
    if (!isInside(realRoot, real)) throw new ReproError('PATH_ESCAPE', 'path escapes the workspace root through a symlink')
    if (!(await stat(real)).isDirectory()) throw new ReproError('NOT_A_DIRECTORY', `not a directory: ${input ?? '.'}`)
    return { absolute: real, id: path.relative(realRoot, real).split(path.sep).join('/') || '.' }
  }

  /**
   * Scan a project and write its manifest + REP record.
   * @param options - optional project path.
   * @returns the manifest and the record path.
   */
  async manifest(options: { path?: string } = {}): Promise<ManifestResult> {
    const directory = await this.resolveDirectory(options.path)
    const scan = await scanProject(directory.absolute, this.#scanOptions(directory.absolute))
    const git = await gitEvidence(directory.absolute)
    const manifest = buildManifest({ rootId: directory.id === '.' ? path.basename(directory.absolute) : directory.id, generatedAt: this.iso(), scan, git })
    const record: ResearchRecord = {
      schemaVersion: 1,
      recordId: stableId('rec', ['repro-audit', manifest.rootId, manifest.generatedAt]),
      createdAt: manifest.generatedAt,
      generator: { name: 'dsh-repro-audit', version: VERSION },
      snapshots: [],
      evidence: [],
      claims: [],
      artifacts: manifest.artifacts.map(artifact => ({ artifactId: artifact.artifactId, kind: artifact.kind, hash: artifact.hash as `sha256:${string}`, ...(artifact.path === undefined ? {} : { path: artifact.path }), ...(artifact.description === undefined ? {} : { description: artifact.description }) })),
      notes: [`reproducibility level: ${manifest.level}`, ...manifest.gaps.map(gap => `${gap.severity}: ${gap.code} — ${gap.detail}`)],
    }
    const validation = validateRep(record)
    if (!validation.ok) throw new ReproError('STORE_ERROR', `refusing to write an invalid REP record: ${validation.issues[0]?.code ?? 'unknown'}`)
    const directoryOut = path.join(this.config.root, 'records')
    await mkdir(directoryOut, { recursive: true })
    const recordPath = path.join(directoryOut, `${record.recordId}.json`)
    await writeFile(recordPath, `${JSON.stringify({ manifest, record }, null, 2)}\n`, 'utf8')
    return { manifest, recordPath }
  }

  /**
   * Compare a stored manifest with the current tree.
   * @param request - `manifest` inline or `manifestPath` inside the workspace.
   * @returns the drift report.
   */
  async check(request: { manifest?: ReproManifest; manifestPath?: string; path?: string }): Promise<DriftReport> {
    let manifest = request.manifest
    if (manifest === undefined) {
      if (request.manifestPath === undefined) throw new ReproError('INVALID_INPUT', 'pass manifest or manifestPath')
      // The manifest is workspace-relative; the project it describes is
      // `path` when given, otherwise the workspace root.
      const workspace = this.config.workspaceRoot
      let realRoot: string
      try {
        realRoot = await realpath(workspace)
      } catch {
        throw new ReproError('NOT_FOUND', `workspace root does not exist: ${workspace}`)
      }
      const absolute = path.resolve(realRoot, request.manifestPath)
      if (!isInside(realRoot, absolute)) throw new ReproError('PATH_ESCAPE', 'manifestPath resolves outside the workspace root')
      let realManifest: string
      try {
        realManifest = await realpath(absolute)
      } catch {
        throw new ReproError('NOT_FOUND', `manifest not found: ${request.manifestPath}`)
      }
      if (!isInside(realRoot, realManifest)) throw new ReproError('PATH_ESCAPE', 'manifestPath escapes the workspace root through a symlink')
      let raw: string
      try {
        raw = await readFile(realManifest, 'utf8')
      } catch {
        throw new ReproError('NOT_FOUND', `manifest not found: ${request.manifestPath}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new ReproError('INVALID_MANIFEST', `manifest is not valid JSON: ${request.manifestPath}`)
      }
      const candidate = isRecord(parsed) && isRecord(parsed['manifest']) ? parsed['manifest'] : parsed
      if (!isManifest(candidate)) {
        throw new ReproError('INVALID_MANIFEST', 'the manifest must have manifestVersion 1, artifacts, gaps and warnings arrays, and a rootId')
      }
      manifest = candidate
    }
    if (!isManifest(manifest)) {
      throw new ReproError('INVALID_MANIFEST', 'the manifest must have manifestVersion 1, artifacts, gaps and warnings arrays, and a rootId')
    }
    const directory = await this.resolveDirectory(request.path)
    const git = await gitEvidence(directory.absolute)
    const scan = await scanProject(directory.absolute, this.#scanOptions(directory.absolute))
    return compareManifest(manifest, directory.absolute, { generatedAt: this.iso(), git, scan })
  }
}
