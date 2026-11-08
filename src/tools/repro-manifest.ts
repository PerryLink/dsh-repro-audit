/**
 * `repro_manifest` — scan a project and record its reproducibility artifacts.
 * @module dsh-repro-audit/tools/repro-manifest
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ReproError, type ReproAuditRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    manifest: { type: 'json' },
    recordPath: { type: 'string' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `repro_manifest` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeReproManifestTool(runtime: ReproAuditRuntime) {
  return defineTool({
    name: 'repro_manifest',
    description: [
      'Scan a project and record what makes it reproducible (dsh-repro-audit).',
      '',
      'Read-only and bounded: records the git commit and dirty state, dependency lockfiles, environment pins, input-data hashes, figure hashes, notebooks, explicit random seeds and runnable commands, then derives gaps and a level (`reproducible` / `partial` / `not_reproducible`). Project code is never executed; only `git rev-parse`/`status` subprocesses run.',
      '',
      'Use the returned manifest with repro_check later to detect drift, and repro_card to render a report card for a supervisor or reviewer.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', description: 'Workspace-relative project directory (default: the workspace root).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; manifest: { level: string; artifacts: unknown[]; gaps: Array<{ severity: string; code: string }> } } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `repro_manifest failed (${result.error.code}): ${result.error.message}` }]
        const errors = result.manifest.gaps.filter(gap => gap.severity === 'error').map(gap => gap.code)
        const warnings = result.manifest.gaps.filter(gap => gap.severity === 'warning').length
        return [
          {
            type: 'text',
            text: `repro_manifest: ${result.manifest.level} — ${result.manifest.artifacts.length} artifact(s), ${errors.length} error gap(s)${errors.length === 0 ? '' : ` (${errors.join(', ')})`}, ${warnings} warning(s)`,
          },
        ]
      },
    },
    async execute(args: unknown) {
      const request = args as { path?: string }
      try {
        const result = await runtime.manifest(request.path === undefined ? {} : { path: request.path })
        return { ok: true as const, manifest: result.manifest as never, recordPath: result.recordPath }
      } catch (error) {
        if (error instanceof ReproError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
