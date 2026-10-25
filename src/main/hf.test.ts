import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./store', () => ({ getSettings: vi.fn(async () => ({ hfToken: null })) }))

import { getRepoGgufFiles } from './hf'

afterEach(() => vi.unstubAllGlobals())

describe('Hugging Face integrity metadata', () => {
  it('preserves directory paths so matching basenames cannot overwrite checksums', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { type: 'file', path: 'first/model.gguf', lfs: { size: 10, oid: 'AAAA' } },
      { type: 'file', path: 'second/model.gguf', lfs: { size: 20, oid: 'BBBB' } },
      { type: 'file', path: 'README.md', size: 5 }
    ]))))
    const files = await getRepoGgufFiles('test/repo')
    expect([...files]).toEqual([
      ['first/model.gguf', { size: 10, sha256: 'aaaa' }],
      ['second/model.gguf', { size: 20, sha256: 'bbbb' }]
    ])
  })
})
