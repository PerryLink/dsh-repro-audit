/**
 * `repro_check` — compare a stored manifest with the current tree.
 * @module dsh-repro-audit/tools/repro-check
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ReproError, type ReproAuditRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    drift: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `repro_check` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeReproCheckTool(runtime: ReproAuditRuntime) {
  return defineTool({
    name: 'repro_check',
    description: [
      'Compare a recorded reproducibility manifest with the project as it is now (dsh-repro-audit).',
      '',
      'Reports artifacts that changed, disappeared or were added — data, lockfiles, environment pins, figures, notebooks, seeds and commands — and downgrades the level when anything that the manifest recorded no longer matches.',
    ].join('\n'),
    parameters: {
      manifest: { type: 'json', description: 'A manifest returned by repro_manifest.' },
      manifestPath: { type: 'string', description: 'Workspace-relative path to a saved repro_manifest JSON (record format is accepted).' },
      path: { type: 'string', description: 'Workspace-relative project directory to re-scan (default: the manifest file\'s directory, or the workspace root).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; drift: { level: string; findings: unknown[] } } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `repro_check failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: `repro_check: ${result.drift.level} — ${result.drift.findings.length} drift finding(s)` }]
      },
    },
    async execute(args: unknown) {
      const request = args as { manifest?: never; manifestPath?: string; path?: string }
      try {
        const drift = await runtime.check({
          ...(request.manifest === undefined ? {} : { manifest: request.manifest }),
          ...(request.manifestPath === undefined ? {} : { manifestPath: request.manifestPath }),
          ...(request.path === undefined ? {} : { path: request.path }),
        })
        return { ok: true as const, drift: drift as never }
      } catch (error) {
        if (error instanceof ReproError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
