/**
 * Mount contract: disabled mounts nothing; enabled mounts exactly three tools.
 * @module test/mount.spec
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('mount', () => {
  it('honours enabled and registers three unique tools', () => {
    const names: string[] = []
    const makeCtx = (): never =>
      ({
        logger: () => ({ info: () => {} }),
        tools: {
          register: (tool: { name: string }) => {
            names.push(tool.name)
          },
        },
        effect: (fn: () => unknown) => {
          fn()
        },
        get: () => undefined,
      }) as never
    apply(makeCtx(), { enabled: false })
    expect(names).toEqual([])
    apply(makeCtx(), { enabled: true })
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
  })
})
