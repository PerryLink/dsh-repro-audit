/**
 * Scanner and manifest: artifacts, gaps, level, drift.
 * @module test/scan-manifest.spec
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildManifest, compareManifest, gapsOf, levelOf } from '../src/manifest.ts'
import { scanProject } from '../src/scan.ts'
import { gitEvidence } from '../src/runtime.ts'

const execFileAsync = promisify(execFile)
const AT = '2026-08-01T09:00:00.000Z'
let root: string

/** Run git in the fixture. */
async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args])
}

/** Create a fully reproducible fixture project. */
async function makeProject(): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { analyze: 'python analysis.py' } }), 'utf8')
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8')
  await writeFile(path.join(root, '.nvmrc'), '24\n', 'utf8')
  await writeFile(path.join(root, 'analysis.py'), 'import numpy as np\nnp.random.seed(42)\nprint("ok")\n', 'utf8')
  await mkdir(path.join(root, 'data'), { recursive: true })
  await writeFile(path.join(root, 'data', 'input.csv'), 'id,value\n1,2\n', 'utf8')
  await mkdir(path.join(root, 'figures'), { recursive: true })
  await writeFile(path.join(root, 'figures', 'fig1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-q', '-m', 'fixture')
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'repro-audit-'))
  await makeProject()
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

describe('scan', () => {
  it('finds lockfiles, data, figures, seeds, commands and runtimes', async () => {
    const scan = await scanProject(root)
    expect(scan.lockfiles.map(file => file.path)).toContain('package-lock.json')
    expect(scan.data.map(file => file.path)).toContain('data/input.csv')
    expect(scan.figures.map(file => file.path)).toContain('figures/fig1.png')
    expect(scan.seeds[0]?.value).toBe(42)
    expect(scan.commands.some(command => command.name === 'analyze')).toBe(true)
    expect(scan.runtimes.node).toBe('24')
  })

  it('skips node_modules and reports symlinks without following them', async () => {
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'secret', 'utf8')
    try {
      await symlink(path.join(root, 'data', 'input.csv'), path.join(root, 'linked.csv'))
    } catch (error) {
      // Windows without Developer Mode/symlink privilege: the skip branch is
      // still exercised on Linux/macOS CI, where the assertion below runs.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    const scan = await scanProject(root)
    expect(scan.files.some(file => file.path.startsWith('node_modules'))).toBe(false)
    expect(scan.warnings).toContain('symlink skipped: linked.csv')
    expect(scan.files.some(file => file.path === 'linked.csv')).toBe(false)
  })

  it('caps the file count and says so', async () => {
    const scan = await scanProject(root, { maxFiles: 3 })
    expect(scan.truncated).toBe(true)
  })
})

describe('git evidence', () => {
  it('does not execute a repository-local fsmonitor hook', async () => {
    if (process.platform === 'win32') return
    const hook = path.join(root, 'fsmonitor.sh')
    const marker = path.join(root, 'fsmonitor-called')
    await writeFile(hook, `#!/bin/sh\necho called >> ${JSON.stringify(marker)}\nprintf '1\\n'\n`, { encoding: 'utf8', mode: 0o755 })
    await git('config', 'core.fsmonitor', hook)
    const evidence = await gitEvidence(root)
    expect(evidence.commit).toBeDefined()
    expect(existsSync(marker)).toBe(false)
  })

  it('ignores inherited GIT_* environment overrides', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'repro-other-'))
    try {
      await execFileAsync('git', ['-C', other, 'init', '-q'])
      const expected = (await gitEvidence(root)).commit
      expect(expected).toBeDefined()
      const original = process.env['GIT_DIR']
      process.env['GIT_DIR'] = path.join(other, '.git')
      try {
        const evidence = await gitEvidence(root)
        expect(evidence.commit).toBe(expected)
      } finally {
        if (original === undefined) delete process.env['GIT_DIR']
        else process.env['GIT_DIR'] = original
      }
    } finally {
      if (other.startsWith(tmpdir())) await rm(other, { recursive: true, force: true })
    }
  })
})

describe('manifest', () => {
  it('is reproducible when every signal is present and the tree is clean', async () => {
    const scan = await scanProject(root)
    const manifest = buildManifest({ rootId: 'fixture', generatedAt: AT, scan, git: await gitEvidence(root) })
    expect(manifest.level).toBe('reproducible')
    expect(manifest.gaps).toEqual([])
    expect(manifest.artifacts.some(artifact => artifact.kind === 'code')).toBe(true)
    expect(manifest.artifacts.some(artifact => artifact.kind === 'seed')).toBe(true)
  })

  it('degrades to partial without a seed and to not_reproducible without git', async () => {
    await writeFile(path.join(root, 'analysis.py'), 'print("no seed here")\n', 'utf8')
    const scanWithoutSeed = await scanProject(root)
    const partial = buildManifest({ rootId: 'fixture', generatedAt: AT, scan: scanWithoutSeed, git: await gitEvidence(root) })
    expect(partial.level).toBe('partial')
    expect(partial.gaps.some(gap => gap.code === 'no_seed' && gap.severity === 'warning')).toBe(true)

    const noGit = buildManifest({ rootId: 'fixture', generatedAt: AT, scan: scanWithoutSeed, git: { error: 'not a git repository' } })
    expect(noGit.level).toBe('not_reproducible')
    expect(noGit.gaps.some(gap => gap.code === 'no_git_commit')).toBe(true)
  })

  it('counts a dirty worktree as a warning', async () => {
    await writeFile(path.join(root, 'extra.txt'), 'uncommitted', 'utf8')
    const scan = await scanProject(root)
    const manifest = buildManifest({ rootId: 'fixture', generatedAt: AT, scan, git: await gitEvidence(root) })
    expect(manifest.git.dirty).toBe(true)
    expect(manifest.level).toBe('partial')
  })

  it('does not count project config as data and recognizes lowercase .r scripts', async () => {
    await rm(path.join(root, 'data'), { recursive: true, force: true })
    await rm(path.join(root, 'analysis.py'))
    await writeFile(path.join(root, 'analysis.r'), 'print("no seed here")\n', 'utf8')
    const scan = await scanProject(root)
    expect(scan.data).toEqual([])
    expect(scan.scripts.map(file => file.path)).toContain('analysis.r')
    const gaps = gapsOf(scan, { error: 'no git' })
    expect(gaps.map(gap => gap.code)).toEqual(expect.arrayContaining(['no_data', 'no_seed']))
  })

  it('builds gap severities deterministically for an empty project', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'repro-empty-'))
    try {
      const scan = await scanProject(empty)
      const gaps = gapsOf(scan, { error: 'no git' })
      expect(gaps.map(gap => gap.code)).toEqual(expect.arrayContaining(['no_git_commit', 'no_lockfile', 'no_run_command', 'no_data', 'no_environment', 'no_figures']))
      expect(levelOf(gaps)).toBe('not_reproducible')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('drift', () => {
  it('detects a changed data file and a missing artifact', async () => {
    const scan = await scanProject(root)
    const manifest = buildManifest({ rootId: 'fixture', generatedAt: AT, scan, git: await gitEvidence(root) })
    await writeFile(path.join(root, 'data', 'input.csv'), 'id,value\n1,3\n', 'utf8')
    await rm(path.join(root, 'figures', 'fig1.png'))
    const report = await compareManifest(manifest, root, { generatedAt: '2026-08-02T09:00:00.000Z', git: await gitEvidence(root) })
    expect(report.level).toBe('not_reproducible')
    expect(report.findings.some(finding => finding.status === 'changed' && finding.path === 'data/input.csv')).toBe(true)
    expect(report.findings.some(finding => finding.status === 'missing' && finding.path === 'figures/fig1.png')).toBe(true)
  })

  it('reports a clean check when nothing changed', async () => {
    const scan = await scanProject(root)
    const manifest = buildManifest({ rootId: 'fixture', generatedAt: AT, scan, git: await gitEvidence(root) })
    const report = await compareManifest(manifest, root, { generatedAt: AT, git: await gitEvidence(root) })
    expect(report.findings).toEqual([])
    expect(report.level).toBe('reproducible')
  })
})
