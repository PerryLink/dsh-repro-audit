/**
 * Config schema and resolution for `dsh-repro-audit`.
 * @module dsh-repro-audit/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config. */
export interface Config {
  enabled?: boolean
  /** Store/record root. */
  root?: string
  /** Workspace root that project paths must stay inside. */
  workspaceRoot?: string
  /** Maximum files visited per scan. */
  maxFiles?: number
  /** Maximum directory depth. */
  maxDepth?: number
  /** Maximum bytes hashed per file. */
  maxFileBytes?: number
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly workspaceRoot: string
  readonly maxFiles: number
  readonly maxDepth: number
  readonly maxFileBytes: number
}

/** Schemastery schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.repro-audit'),
  workspaceRoot: z.string(),
  maxFiles: z.number().default(2000),
  maxDepth: z.number().default(6),
  maxFileBytes: z.number().default(8 * 1024 * 1024),
})

/** Throw unless the value is a positive safe integer. */
function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.repro-audit'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  const maxFiles = config.maxFiles ?? 2000
  const maxDepth = config.maxDepth ?? 6
  const maxFileBytes = config.maxFileBytes ?? 8 * 1024 * 1024
  for (const [name, value] of Object.entries({ maxFiles, maxDepth, maxFileBytes })) assertPositiveInt(name, value)
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    workspaceRoot: path.resolve(config.workspaceRoot ?? process.cwd()),
    maxFiles,
    maxDepth,
    maxFileBytes,
  }
}
