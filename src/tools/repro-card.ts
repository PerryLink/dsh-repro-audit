/**
 * `repro_card` — human report card + SARIF for a manifest and optional drift.
 * @module dsh-repro-audit/tools/repro-card
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DriftReport, ReproManifest } from '../manifest.ts'
import { renderDriftMarkdown, renderManifestMarkdown, renderReproSarif } from '../report.ts'
import { VERSION } from '../version.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    markdown: { type: 'string' },
    sarif: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `repro_card` tool.
 * @returns the tool definition.
 */
export function makeReproCardTool() {
  return defineTool({
    name: 'repro_card',
    description: [
      'Render a reproducibility report card (Markdown + SARIF 2.1.0) from a manifest and, optionally, a drift report (dsh-repro-audit).',
      '',
      'The card lists the gaps with severity and a concrete suggestion, every artifact with its hash, and the git/runtime evidence. It states explicitly that a manifest proves bytes existed, not that the analysis is correct.',
    ].join('\n'),
    parameters: {
      manifest: { type: 'json', required: true, description: 'A manifest returned by repro_manifest.' },
      drift: { type: 'json', description: 'Optional drift report from repro_check.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; markdown: string } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `repro_card failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: result.markdown }]
      },
    },
    async execute(args: unknown) {
      const request = args as { manifest?: ReproManifest; drift?: DriftReport }
      const manifest = request.manifest
      if (manifest === undefined || manifest.manifestVersion !== 1
        || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.gaps)
        || !Array.isArray(manifest.warnings) || !Array.isArray(manifest.commands) || !Array.isArray(manifest.seeds)
        || typeof manifest.rootId !== 'string' || typeof manifest.level !== 'string' || typeof manifest.generatedAt !== 'string'
        || typeof manifest.truncated !== 'boolean' || typeof manifest.git !== 'object' || manifest.git === null
        || typeof manifest.runtimes !== 'object' || manifest.runtimes === null) {
        return { ok: false as const, error: { code: 'INVALID_MANIFEST', message: 'pass a manifest returned by repro_manifest' } }
      }
      const malformedGap = manifest.gaps.some(gap => gap === null || typeof gap !== 'object'
        || typeof gap.code !== 'string' || typeof gap.severity !== 'string'
        || typeof gap.detail !== 'string' || typeof gap.suggestion !== 'string')
      const malformedArtifact = manifest.artifacts.some(artifact => artifact === null || typeof artifact !== 'object'
        || typeof artifact.kind !== 'string' || typeof artifact.hash !== 'string')
      if (malformedGap || malformedArtifact) {
        return { ok: false as const, error: { code: 'INVALID_MANIFEST', message: 'the manifest contains malformed gaps or artifacts' } }
      }
      if (request.drift !== undefined && (!Array.isArray(request.drift.findings) || typeof request.drift.level !== 'string' || typeof request.drift.checkedAt !== 'string')) {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'drift must be a drift report returned by repro_check' } }
      }
      const malformedFinding = request.drift?.findings.some(finding => finding === null || typeof finding !== 'object'
        || typeof finding.status !== 'string' || typeof finding.kind !== 'string'
        || (finding.expected !== undefined && typeof finding.expected !== 'string')
        || (finding.actual !== undefined && typeof finding.actual !== 'string'))
      if (malformedFinding === true) {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'drift contains a malformed finding' } }
      }
      const markdown = request.drift === undefined ? renderManifestMarkdown(manifest) : `${renderManifestMarkdown(manifest)}\n${renderDriftMarkdown(request.drift)}`
      return { ok: true as const, markdown, sarif: renderReproSarif(manifest, request.drift, VERSION) as never }
    },
  })
}
