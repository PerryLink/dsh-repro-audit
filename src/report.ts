/**
 * Markdown and SARIF rendering for reproducibility manifests and drift reports.
 * @module dsh-repro-audit/report
 */

import type { DriftReport, ManifestArtifact, ReproGap, ReproManifest } from './manifest.ts'

/** Render one artifact row. */
function artifactRow(artifact: ManifestArtifact): string {
  return `| ${artifact.kind} | ${artifact.path ?? '—'} | \`${artifact.hash.slice(0, 23)}…\` | ${artifact.description ?? ''} |`
}

/** Render a manifest as Markdown. */
export function renderManifestMarkdown(manifest: ReproManifest): string {
  const lines = ['# Reproducibility manifest', '']
  lines.push(`**Level:** \`${manifest.level}\``)
  lines.push(`**Project:** \`${manifest.rootId}\` · **generated:** ${manifest.generatedAt}`)
  if (manifest.git.commit !== undefined) {
    lines.push(`**Git:** \`${manifest.git.commit}\`${manifest.git.branch === undefined ? '' : ` on ${manifest.git.branch}`}${manifest.git.dirty === true ? ' (dirty worktree)' : ''}`)
  } else {
    lines.push(`**Git:** unavailable (${manifest.git.error ?? 'no commit'})`)
  }
  const runtimes = Object.entries(manifest.runtimes)
  if (runtimes.length > 0) lines.push(`**Runtimes:** ${runtimes.map(([name, version]) => `${name} ${version}`).join(', ')}`)
  lines.push('')
  if (manifest.gaps.length > 0) {
    lines.push('## Gaps')
    lines.push('')
    lines.push('| Severity | Code | Detail | Suggestion |')
    lines.push('|---|---|---|---|')
    for (const gap of manifest.gaps) lines.push(`| ${gap.severity} | ${gap.code} | ${gap.detail.replace(/\|/gu, '\\|')} | ${gap.suggestion.replace(/\|/gu, '\\|')} |`)
    lines.push('')
  }
  lines.push(`## Artifacts (${manifest.artifacts.length})`)
  lines.push('')
  lines.push('| Kind | Path | Hash | Description |')
  lines.push('|---|---|---|---|')
  for (const artifact of manifest.artifacts) lines.push(artifactRow(artifact))
  lines.push('')
  if (manifest.truncated) lines.push('> The scan hit its file cap; the manifest does not cover the whole project.')
  if (manifest.warnings.length > 0) {
    lines.push('## Scan warnings')
    lines.push('')
    for (const warning of manifest.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  lines.push('> A manifest proves that these bytes existed when it was recorded. It does not prove that the analysis is correct, or that these are all the inputs.')
  return `${lines.join('\n')}\n`
}

/** Render a drift report as Markdown. */
export function renderDriftMarkdown(report: DriftReport): string {
  const lines = ['# Reproducibility drift check', '']
  lines.push(`**Level now:** \`${report.level}\` · **checked:** ${report.checkedAt}`)
  lines.push('')
  if (report.findings.length === 0) {
    lines.push('No artifact changed, disappeared or appeared since the manifest.')
  } else {
    lines.push(`| Status | Kind | Path | Expected | Actual |`)
    lines.push('|---|---|---|---|---|')
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.status} | ${finding.kind} | ${finding.path ?? '—'} | ${finding.expected === undefined ? '—' : `\`${finding.expected.slice(0, 19)}…\``} | ${finding.actual === undefined ? '—' : `\`${finding.actual.slice(0, 19)}…\``} |`,
      )
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Render gaps and drift as SARIF 2.1.0. */
export function renderReproSarif(manifest: ReproManifest, drift: DriftReport | undefined, version: string): Record<string, unknown> {
  const results: Array<Record<string, unknown>> = []
  for (const gap of manifest.gaps.filter(item => item.severity !== 'info')) {
    results.push({
      ruleId: `repro-audit/${gap.code}`,
      level: gap.severity === 'error' ? 'error' : 'warning',
      message: { text: `${gap.detail} — ${gap.suggestion}` },
      properties: { code: gap.code, severity: gap.severity },
    })
  }
  for (const finding of drift?.findings ?? []) {
    results.push({
      ruleId: `repro-audit/drift-${finding.status}`,
      level: finding.status === 'changed' || finding.status === 'missing' ? 'error' : 'warning',
      message: { text: finding.detail },
      properties: { kind: finding.kind, path: finding.path ?? null, expected: finding.expected ?? null, actual: finding.actual ?? null },
    })
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'dsh-repro-audit', version } }, results }],
  }
}

/** Re-export for tool convenience. */
export type { ReproGap }
