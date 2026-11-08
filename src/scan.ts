/**
 * Project scanning for reproducibility evidence.
 *
 * The scanner is read-only and bounded: it never executes project code, never
 * follows symlinks out of the root, and caps files, depth and hashed bytes.
 * Everything it records is either a hash, a version string, a command name or a
 * seed literal — never file contents.
 *
 * @module dsh-repro-audit/scan
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** Directories never descended into. */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'out', 'target',
  '__pycache__', 'coverage', '.next', '.cache', '.idea', '.vscode', '.tox', '.mypy_cache',
  // The plugin's default record store lives inside the workspace; never scan it.
  '.repro-audit',
])

/** File names treated as dependency locks. */
const LOCKFILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lockb',
  'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'uv.lock', 'renv.lock', 'Cargo.lock',
  'go.sum', 'composer.lock', 'environment.yml', 'environment.yaml', 'Gemfile.lock',
])

/** File names that pin a runtime or environment. */
const ENV_FILES = new Set([
  '.nvmrc', '.node-version', '.python-version', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'Dockerfile', 'devcontainer.json', '.tool-versions', 'tox.ini', 'rust-toolchain.toml',
])

/** Code extensions scanned for seeds and commands. */
const SCRIPT_EXTENSIONS = new Set(['.py', '.r', '.js', '.mjs', '.cjs', '.ts', '.sh', '.jl', '.rmd', '.qmd'])

/** Data extensions. */
const DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.parquet', '.json', '.h5', '.hdf5', '.nii', '.nc', '.xlsx', '.arrow', '.feather', '.sav', '.dta'])

/** Figure extensions. */
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.pdf', '.tif', '.tiff', '.eps'])

/** Project/build configuration JSON that is not input data. */
function isProjectConfig(base: string): boolean {
  return base === 'package.json' || base === 'jsconfig.json' || /^tsconfig(\..+)?\.json$/u.test(base)
}

/** Seed patterns, with the literal they carry. */
const SEED_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /\brandom_state\s*=\s*(-?\d+)/gu, kind: 'sklearn-random_state' },
  { pattern: /\bnp\.random\.seed\s*\(\s*(-?\d+)/gu, kind: 'numpy-seed' },
  { pattern: /\brandom\.seed\s*\(\s*(-?\d+)/gu, kind: 'python-random-seed' },
  { pattern: /\bset\.seed\s*\(\s*(-?\d+)/gu, kind: 'r-set.seed' },
  { pattern: /\btorch\.manual_seed\s*\(\s*(-?\d+)/gu, kind: 'torch-seed' },
  { pattern: /\btf\.random\.set_seed\s*\(\s*(-?\d+)/gu, kind: 'tensorflow-seed' },
  { pattern: /\bseed\s*[:=]\s*(-?\d+)/gu, kind: 'generic-seed' },
]

/** One hashed file. */
export interface ScannedFile {
  readonly path: string
  readonly bytes: number
  readonly hash?: string
  readonly reason?: string
}

/** One discovered seed. */
export interface ScannedSeed {
  readonly path: string
  readonly line: number
  readonly value: number
  readonly kind: string
}

/** One runnable command. */
export interface ScannedCommand {
  readonly name: string
  readonly source: string
  readonly command: string
}

/** The scan result. */
export interface ScanResult {
  readonly rootId: string
  readonly files: readonly ScannedFile[]
  readonly lockfiles: readonly ScannedFile[]
  readonly envFiles: readonly ScannedFile[]
  readonly data: readonly ScannedFile[]
  readonly figures: readonly ScannedFile[]
  readonly notebooks: readonly ScannedFile[]
  readonly scripts: readonly ScannedFile[]
  readonly seeds: readonly ScannedSeed[]
  readonly commands: readonly ScannedCommand[]
  readonly runtimes: { readonly node?: string; readonly python?: string }
  readonly truncated: boolean
  readonly warnings: readonly string[]
}

/** Options for {@link scanProject}. */
export interface ScanOptions {
  /** Maximum files visited (default 2000). */
  readonly maxFiles?: number
  /** Maximum directory depth (default 6). */
  readonly maxDepth?: number
  /** Maximum bytes hashed per file (default 8 MiB). */
  readonly maxFileBytes?: number
  /** Absolute paths (and their descendants) to leave out of the scan. */
  readonly ignorePaths?: readonly string[]
}

/** Hash one buffer. */
function sha256(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

/** Canonicalize a path whose leaf may not exist yet (realpath the ancestor). */
export function canonicalPath(input: string): string {
  try {
    return realpathSync(input)
  } catch {
    const parent = path.dirname(input)
    if (parent === input) return input
    return path.join(canonicalPath(parent), path.basename(input))
  }
}

/** True when `candidate` is inside `root`. */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/** Read a small text file, or undefined. */
async function readSmall(file: string, limit = 1024 * 1024): Promise<string | undefined> {
  try {
    const info = await stat(file)
    if (info.size > limit) return undefined
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Extract package.json scripts. */
function scriptsOf(packageJson: string): ScannedCommand[] {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> }
    return Object.entries(parsed.scripts ?? {})
      .filter(([, command]) => typeof command === 'string')
      .map(([name, command]) => ({ name, source: 'package.json', command }))
  } catch {
    return []
  }
}

/** Extract Makefile targets. */
function makeTargets(makefile: string): ScannedCommand[] {
  const commands: ScannedCommand[] = []
  for (const match of makefile.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gmu)) {
    const name = match[1]!
    if (name.startsWith('.')) continue
    commands.push({ name, source: 'Makefile', command: `make ${name}` })
  }
  return commands
}

/** Find seed literals in a script. */
function seedsOf(relative: string, source: string): ScannedSeed[] {
  const seeds: ScannedSeed[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const { pattern, kind } of SEED_PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match === null) continue
      const value = Number(match[1])
      if (!Number.isFinite(value)) continue
      seeds.push({ path: relative, line: index + 1, value, kind })
      break
    }
  }
  return seeds
}

/** Classify one relative path. */
function classify(relative: string): 'lockfile' | 'env' | 'data' | 'figure' | 'notebook' | 'script' | 'other' {
  const base = path.basename(relative)
  const extension = path.extname(base).toLowerCase()
  const directory = relative.split('/').slice(0, -1).join('/').toLowerCase()
  if (LOCKFILES.has(base)) return 'lockfile'
  if (ENV_FILES.has(base)) return 'env'
  if (isProjectConfig(base)) return 'other'
  if (extension === '.ipynb') return 'notebook'
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script'
  if (FIGURE_EXTENSIONS.has(extension) || /(^|\/)(figures?|figs?|plots?)(\/|$)/u.test(directory)) return 'figure'
  if (DATA_EXTENSIONS.has(extension) || /(^|\/)(data|datasets?|inputs?)(\/|$)/u.test(directory)) return 'data'
  return 'other'
}

/**
 * Scan a project directory.
 * @param root - absolute project root.
 * @param options - bounds.
 * @returns the scan result.
 */
export async function scanProject(inputRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = canonicalPath(inputRoot)
  const maxFiles = options.maxFiles ?? 2000
  const maxDepth = options.maxDepth ?? 6
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
  const ignorePaths = (options.ignorePaths ?? []).map(item => canonicalPath(item))
  const isIgnored = (absolute: string): boolean => ignorePaths.some(ignore => absolute === ignore || isInside(ignore, absolute))
  const lockfiles: ScannedFile[] = []
  const envFiles: ScannedFile[] = []
  const data: ScannedFile[] = []
  const figures: ScannedFile[] = []
  const notebooks: ScannedFile[] = []
  const scripts: ScannedFile[] = []
  const warnings: string[] = []
  const seedList: ScannedSeed[] = []
  let visited = 0
  let truncated = false

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      warnings.push(`directory depth limit reached at ${path.relative(root, directory) || '.'}`)
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      warnings.push(`cannot read ${path.relative(root, directory) || '.'}: ${(error as Error).message}`)
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (visited >= maxFiles) {
        truncated = true
        return
      }
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (isIgnored(absolute)) continue
      if (entry.isSymbolicLink()) {
        warnings.push(`symlink skipped: ${relative}`)
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      visited += 1
      const kind = classify(relative)
      const info = await stat(absolute)
      const record = (hash?: string, reason?: string): ScannedFile => ({
        path: relative,
        bytes: info.size,
        ...(hash === undefined ? {} : { hash }),
        ...(reason === undefined ? {} : { reason }),
      })
      if (info.size > maxFileBytes) {
        const oversized = record(undefined, `larger than the ${maxFileBytes}-byte hash cap`)
        if (kind === 'data') data.push(oversized)
        else if (kind === 'figure') figures.push(oversized)
        else warnings.push(`not hashed: ${relative} (${info.size} bytes)`)
        continue
      }
      const content = await readFile(absolute)
      const hash = sha256(content)
      if (kind === 'lockfile') lockfiles.push(record(hash))
      else if (kind === 'env') envFiles.push(record(hash))
      else if (kind === 'data') data.push(record(hash))
      else if (kind === 'figure') figures.push(record(hash))
      else if (kind === 'notebook') notebooks.push(record(hash))
      else if (kind === 'script') scripts.push(record(hash))
      if (kind === 'script' && info.size <= 1024 * 1024) {
        seedList.push(...seedsOf(relative, content.toString('utf8')))
      }
    }
  }

  await walk(root, 0)

  const commands: ScannedCommand[] = []
  const packageJson = await readSmall(path.join(root, 'package.json'))
  if (packageJson !== undefined) commands.push(...scriptsOf(packageJson))
  const makefile = (await readSmall(path.join(root, 'Makefile'))) ?? (await readSmall(path.join(root, 'makefile')))
  if (makefile !== undefined) commands.push(...makeTargets(makefile))
  for (const script of scripts) {
    const base = path.basename(script.path)
    if (/^(run|reproduce|analysis|main)\.(sh|py|r)$/iu.test(base) && !script.path.includes('/')) {
      commands.push({ name: base, source: 'script', command: base.endsWith('.sh') ? `bash ${base}` : base.endsWith('.py') ? `python ${base}` : `Rscript ${base}` })
    }
  }

  let node: string | undefined
  for (const name of ['.nvmrc', '.node-version']) {
    const value = await readSmall(path.join(root, name))
    if (value !== undefined && value.trim() !== '') node = value.trim().replace(/^v/u, '')
  }
  let python: string | undefined
  const pythonVersion = await readSmall(path.join(root, '.python-version'))
  if (pythonVersion !== undefined && pythonVersion.trim() !== '') python = pythonVersion.trim()
  const pyproject = await readSmall(path.join(root, 'pyproject.toml'))
  if (python === undefined && pyproject !== undefined) {
    const match = /requires-python\s*=\s*"([^"]+)"/u.exec(pyproject)
    if (match !== null) python = match[1]
  }

  return {
    rootId: path.basename(root),
    files: [...lockfiles, ...envFiles, ...data, ...figures, ...notebooks, ...scripts],
    lockfiles,
    envFiles,
    data,
    figures,
    notebooks,
    scripts,
    seeds: seedList,
    commands,
    runtimes: { ...(node === undefined ? {} : { node }), ...(python === undefined ? {} : { python }) },
    truncated,
    warnings,
  }
}
