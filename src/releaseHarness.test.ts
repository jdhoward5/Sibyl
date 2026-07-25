import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release harness', () => {
  it('opts packaged model smoke tests into an isolated throwaway profile', () => {
    const script = readFileSync(
      path.resolve(process.cwd(), 'scripts', 'clean-release-build.mjs'),
      'utf8'
    )

    expect(script).toContain("SIBYL_SMOKE_ISOLATED: '1'")
    expect(script).toContain(
      "mkdtempSync(path.join(os.tmpdir(), 'sibyl-release-smoke-'))"
    )
    expect(script).toContain('`--user-data-dir=${smokeProfile}`')
  })
})
