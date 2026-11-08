/**
 * Runtime and tool surface: records, drift, path safety, renderers.
 * @module test/runtime-tools.spec
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { validateRep } from '@perrylink/dsh-research-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ReproManifest } from '../src/manifest.ts'
import { ReproAuditRuntime, ReproError } from '../src/runtime.ts'
import { makeReproCardTool } from '../src/tools/repro-card.ts'
import { makeReproCheckTool } from '../src/tools/repro-check.ts'
import { makeReproManifestTool } from '../src/tools/repro-manifest.ts'
import { VERSION } from '../src/version.ts'

const execFileAsync = promisify(execFile)
const AT = new Date('2026-08-01T09:00:00.000Z')
let workspace: string
let store: string

/** Run git in the fixture. */
async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', workspace, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args])
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'repro-tools-'))
  store = await mkdtemp(path.join(tmpdir(), 'repro-store-'))
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { analyze: 'python analysis.py' } }), 'utf8')
  await writeFile(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8')
  await writeFile(path.join(workspace, '.nvmrc'), '24\n', 'utf8')
  await writeFile(path.join(workspace, 'analysis.py'), 'np.random.seed(7)\n', 'utf8')
  await mkdir(path.join(workspace, 'data'), { recursive: true })
  await writeFile(path.join(workspace, 'data', 'input.csv'), 'a,b\n1,2\n', 'utf8')
  await mkdir(path.join(workspace, 'figures'), { recursive: true })
  await writeFile(path.join(workspace, 'figures', 'fig1.png'), Buffer.from([1, 2, 3]))
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-q', '-m', 'fixture')
})

afterEach(async () => {
  for (const directory of [workspace, store]) {
    if (directory.startsWith(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})

/** Build a runtime over the fixtures. */
function runtime(): ReproAuditRuntime {
  return new ReproAuditRuntime({ config: resolveConfig({ workspaceRoot: workspace, root: store }), now: () => AT })
}

const EXEC = {} as never

describe('runtime', () => {
  it('writes a manifest with a valid REP record', async () => {
    const result = await runtime().manifest()
    expect(result.manifest.level).toBe('reproducible')
    const saved = JSON.parse(await readFile(result.recordPath, 'utf8')) as { manifest: ReproManifest; record: unknown }
    expect(validateRep(saved.record).ok, JSON.stringify(validateRep(saved.record).issues)).toBe(true)
    expect(saved.manifest.artifacts.length).toBeGreaterThan(0)
  })

  it('detects drift against an inline manifest', async () => {
    const rt = runtime()
    const { manifest } = await rt.manifest()
    await writeFile(path.join(workspace, 'data', 'input.csv'), 'a,b\n1,3\n', 'utf8')
    const drift = await rt.check({ manifest })
    expect(drift.level).toBe('not_reproducible')
    expect(drift.findings.some(finding => finding.status === 'changed' && finding.path === 'data/input.csv')).toBe(true)
  })

  it('reads a saved manifest from the workspace', async () => {
    const rt = runtime()
    const { manifest, recordPath } = await rt.manifest()
    const original = JSON.parse(await readFile(recordPath, 'utf8')) as { record: unknown }
    await mkdir(path.join(workspace, 'build'), { recursive: true })
    await writeFile(path.join(workspace, 'build', 'repro.json'), JSON.stringify({ ...original, manifest }), 'utf8')
    // `build/` is excluded from the scan, so storing the manifest there does not
    // itself count as project drift.
    const drift = await rt.check({ manifestPath: 'build/repro.json', path: '.' })
    expect(drift.findings).toEqual([])
  })

  it('rejects malformed saved manifests with INVALID_MANIFEST', async () => {
    const rt = runtime()
    await mkdir(path.join(workspace, 'build'), { recursive: true })
    await writeFile(path.join(workspace, 'build', 'bad.json'), '{not json', 'utf8')
    await expect(rt.check({ manifestPath: 'build/bad.json', path: '.' })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
    await writeFile(path.join(workspace, 'build', 'null.json'), 'null', 'utf8')
    await expect(rt.check({ manifestPath: 'build/null.json', path: '.' })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
    await writeFile(path.join(workspace, 'build', 'shape.json'), JSON.stringify({ manifestVersion: 1, artifacts: [] }), 'utf8')
    await expect(rt.check({ manifestPath: 'build/shape.json', path: '.' })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it('rejects a manifest symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'repro-outside-'))
    try {
      await writeFile(path.join(outside, 'manifest.json'), JSON.stringify({ manifestVersion: 1, artifacts: [], gaps: [], warnings: [], seeds: [], commands: [], rootId: 'outside', generatedAt: AT.toISOString() }), 'utf8')
      try {
        await symlink(path.join(outside, 'manifest.json'), path.join(workspace, 'leak.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return
        throw error
      }
      await expect(runtime().check({ manifestPath: 'leak.json', path: '.' })).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    } finally {
      if (outside.startsWith(tmpdir())) await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not scan its own record store when it lives inside the project', async () => {
    const inside = new ReproAuditRuntime({ config: resolveConfig({ workspaceRoot: workspace, root: path.join(workspace, 'store-inside') }), now: () => AT })
    await inside.manifest()
    const second = await inside.manifest()
    expect(second.manifest.artifacts.some(artifact => artifact.path?.startsWith('store-inside/'))).toBe(false)
    const drift = await inside.check({ manifest: second.manifest })
    expect(drift.findings.some(finding => finding.path?.startsWith('store-inside/'))).toBe(false)
  })

  it('rejects paths outside the workspace', async () => {
    await expect(runtime().manifest({ path: '../elsewhere' })).rejects.toBeInstanceOf(ReproError)
  })
})

describe('tools', () => {
  it('declares names and schemas', () => {
    for (const [tool, name] of [
      [makeReproManifestTool(runtime()), 'repro_manifest'],
      [makeReproCheckTool(runtime()), 'repro_check'],
      [makeReproCardTool(), 'repro_card'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(Object.keys(tool.parameters).length).toBeGreaterThan(0)
      expect(tool.output.schema).toBeDefined()
    }
  })

  it('manifest → check → card end to end', async () => {
    const manifestTool = makeReproManifestTool(runtime())
    const manifestValue = (await manifestTool.execute({}, EXEC)) as { ok: true; manifest: ReproManifest }
    expect(manifestValue.ok).toBe(true)

    const checkValue = (await makeReproCheckTool(runtime()).execute({ manifest: manifestValue.manifest }, EXEC)) as {
      ok: true
      drift: { level: string; findings: unknown[] }
    }
    expect(checkValue.drift.findings).toEqual([])

    const card = (await makeReproCardTool().execute({ manifest: manifestValue.manifest, drift: checkValue.drift }, EXEC)) as {
      ok: true
      markdown: string
      sarif: { version: string }
    }
    expect(card.markdown).toContain('Reproducibility manifest')
    expect(card.sarif.version).toBe('2.1.0')
  })

  it('failure branch carries a stable code', async () => {
    const value = (await makeReproCheckTool(runtime()).execute({}, EXEC)) as { ok: false; error: { code: string } }
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('INVALID_INPUT')
  })

  it('repro_card rejects malformed manifests instead of throwing', async () => {
    const value = (await makeReproCardTool().execute({ manifest: { manifestVersion: 1, artifacts: [] } } as never, EXEC)) as {
      ok: false
      error: { code: string }
    }
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('INVALID_MANIFEST')
  })
})

describe('package', () => {
  it('VERSION matches package.json and the manifest declares a bundle patch', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(pkg['version']).toBe(VERSION)
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(pkg['dependencies']).toEqual({})
  })
})
