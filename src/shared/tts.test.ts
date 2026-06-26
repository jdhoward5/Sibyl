import { describe, it, expect } from 'vitest'
import {
  splitPhonemes,
  phonemesToIds,
  voiceModelUrl,
  voiceConfigUrl,
  findCatalogVoice,
  plainTextForSpeech,
  TTS_VOICE_CATALOG,
  PIPER_VOICES_BASE_URL
} from './tts'

describe('splitPhonemes', () => {
  it('splits by unicode code point, preserving IPA combining marks', () => {
    expect(splitPhonemes('həlˈəʊ')).toEqual(['h', 'ə', 'l', 'ˈ', 'ə', 'ʊ'])
  })
  it('returns empty for empty input', () => {
    expect(splitPhonemes('')).toEqual([])
  })
})

describe('phonemesToIds', () => {
  // A minimal Piper-style map: boundary symbols plus a few phonemes.
  const idMap = { _: [0], '^': [1], $: [2], h: [3], ə: [4], l: [5] }

  it('wraps with BOS+PAD … EOS and pads after every phoneme', () => {
    expect(phonemesToIds(['h', 'ə', 'l'], idMap)).toEqual([1, 0, 3, 0, 4, 0, 5, 0, 2])
  })

  it('drops phonemes that are not in the map', () => {
    expect(phonemesToIds(['h', '??', 'l'], idMap)).toEqual([1, 0, 3, 0, 5, 0, 2])
  })

  it('returns nothing for an empty phoneme list except the boundaries', () => {
    expect(phonemesToIds([], idMap)).toEqual([1, 0, 2])
  })

  it('returns [] when the map lacks Piper boundary symbols', () => {
    expect(phonemesToIds(['h'], { h: [3] })).toEqual([])
  })

  it('supports multi-id mappings', () => {
    const m = { _: [0], '^': [1], $: [2], x: [7, 8] }
    expect(phonemesToIds(['x'], m)).toEqual([1, 0, 7, 8, 0, 2])
  })
})

describe('catalog', () => {
  it('builds resolve URLs under the piper-voices repo', () => {
    const v = TTS_VOICE_CATALOG[0]
    expect(voiceModelUrl(v)).toBe(PIPER_VOICES_BASE_URL + v.modelPath)
    expect(voiceConfigUrl(v)).toBe(PIPER_VOICES_BASE_URL + v.configPath)
    expect(voiceModelUrl(v).startsWith('https://huggingface.co/')).toBe(true)
  })

  it('derives every config path from its model path', () => {
    for (const v of TTS_VOICE_CATALOG) {
      expect(v.configPath).toBe(`${v.modelPath}.json`)
      expect(v.modelPath.endsWith('.onnx')).toBe(true)
    }
  })

  it('has unique ids and positive size hints', () => {
    const ids = new Set(TTS_VOICE_CATALOG.map((v) => v.id))
    expect(ids.size).toBe(TTS_VOICE_CATALOG.length)
    for (const v of TTS_VOICE_CATALOG) expect(v.sizeBytes).toBeGreaterThan(0)
  })

  it('finds a voice by id and ignores unknown/empty ids', () => {
    expect(findCatalogVoice('en_US-amy-medium')?.name).toBe('Amy')
    expect(findCatalogVoice('nope')).toBeUndefined()
    expect(findCatalogVoice(null)).toBeUndefined()
  })
})

describe('plainTextForSpeech', () => {
  it('drops fenced code blocks', () => {
    expect(plainTextForSpeech('Before\n```js\nconst x = 1\n```\nAfter')).toBe('Before\nAfter')
  })

  it('keeps link/image text but not URLs', () => {
    expect(plainTextForSpeech('See [the docs](https://example.com) now')).toBe('See the docs now')
    expect(plainTextForSpeech('![a cat](cat.png)')).toBe('a cat')
  })

  it('strips emphasis, inline code and headings', () => {
    expect(plainTextForSpeech('## Title')).toBe('Title')
    expect(plainTextForSpeech('a **bold** and `code` word')).toBe('a bold and code word')
    expect(plainTextForSpeech('- item one')).toBe('item one')
  })

  it('collapses whitespace and trims', () => {
    expect(plainTextForSpeech('  hello    world  ')).toBe('hello world')
  })
})
