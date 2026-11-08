/**
 * `dsh-repro-audit` — reproducibility evidence for a project.
 *
 * Three tools: repro_manifest (scan + record), repro_check (drift against a
 * recorded manifest), repro_card (Markdown + SARIF). Read-only: project code is
 * never executed; the only subprocesses are `git rev-parse` and `git status`.
 *
 * Function plugin — no default export.
 * @module dsh-repro-audit
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { ReproAuditRuntime } from './runtime.ts'
import { makeReproCardTool } from './tools/repro-card.ts'
import { makeReproCheckTool } from './tools/repro-check.ts'
import { makeReproManifestTool } from './tools/repro-manifest.ts'

/** Cordis plugin name. */
export const name = 'repro-audit'

/** The tool registry is a hard requirement. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export { scanProject, isInside } from './scan.ts'
export type { ScanOptions, ScanResult, ScannedCommand, ScannedFile, ScannedSeed } from './scan.ts'
export { buildManifest, compareManifest, gapsOf, levelOf } from './manifest.ts'
export type { DriftFinding, DriftReport, GitEvidence, ManifestArtifact, ReproGap, ReproLevel, ReproManifest } from './manifest.ts'
export { ReproAuditRuntime, ReproError, gitEvidence } from './runtime.ts'
export type { ManifestResult, ReproAuditRuntimeOptions, ReproErrorCode } from './runtime.ts'
export { renderDriftMarkdown, renderManifestMarkdown, renderReproSarif } from './report.ts'
export { makeReproManifestTool } from './tools/repro-manifest.ts'
export { makeReproCheckTool } from './tools/repro-check.ts'
export { makeReproCardTool } from './tools/repro-card.ts'

/**
 * Mount the three tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('repro-audit')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const runtime = new ReproAuditRuntime({ config: resolved })
  ctx.effect(() => ctx.tools.register(makeReproManifestTool(runtime)), 'repro-audit: repro_manifest tool')
  ctx.effect(() => ctx.tools.register(makeReproCheckTool(runtime)), 'repro-audit: repro_check tool')
  ctx.effect(() => ctx.tools.register(makeReproCardTool()), 'repro-audit: repro_card tool')
}
