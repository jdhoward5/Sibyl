import { describe, expect, it } from 'vitest'
import type { HFGGUFFile } from './types'
import { canonicalGgufFilename, ggufShardFilenames, groupGgufFiles } from './modelFiles'

const file = (rfilename: string, size?: number): HFGGUFFile => ({
  rfilename, size, quant: 'Q4_K_M', multipart: true
})

describe('multipart GGUF downloads', () => {
  it('groups shards once, uses the first shard and sums the complete download', () => {
    expect(groupGgufFiles([
      file('Q4/model-00002-of-00002.gguf', 25),
      file('Q4/model-00001-of-00002.gguf', 75)
    ])).toEqual([{
      rfilename: 'Q4/model-00001-of-00002.gguf',
      quant: 'Q4_K_M', size: 100, multipart: true, shardCount: 2, complete: true
    }])
  })

  it('keeps matching basenames in different repository directories separate', () => {
    expect(groupGgufFiles([file('a/model.gguf', 10), file('b/model.gguf', 20)]))
      .toMatchObject([{ rfilename: 'a/model.gguf', size: 10 }, { rfilename: 'b/model.gguf', size: 20 }])
  })

  it('does not advertise a partial shard set or unknown size as a complete download', () => {
    expect(groupGgufFiles([file('model-00002-of-00002.gguf', 20)])[0])
      .toMatchObject({ complete: false, size: undefined, shardCount: 2 })
    expect(groupGgufFiles([
      file('model-00001-of-00002.gguf', 10), file('model-00002-of-00002.gguf')
    ])[0]).toMatchObject({ complete: true, size: undefined })
  })

  it('canonicalizes legacy shard identities and expands the exact group', () => {
    expect(canonicalGgufFilename('author/repo/Q4/model-00003-of-00003.gguf'))
      .toBe('author/repo/Q4/model-00001-of-00003.gguf')
    expect(ggufShardFilenames('model-00002-of-00002.gguf'))
      .toEqual(['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf'])
    expect(canonicalGgufFilename('model-00000-of-00002.gguf')).toBe('model-00000-of-00002.gguf')
  })
})
