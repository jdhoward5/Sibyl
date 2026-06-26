import { describe, it, expect } from 'vitest'
import type { Conversation } from './types'
import {
  buildExport,
  conversationToMarkdown,
  conversationToText,
  exportFileBaseName
} from './export'

const conv: Conversation = {
  id: 'c1',
  title: 'My Chat',
  modelId: 'm1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  messages: [
    { id: 's', role: 'system', content: 'be nice', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'u1', role: 'user', content: 'Hello there', createdAt: '2026-01-01T00:00:01.000Z' },
    { id: 'a1', role: 'assistant', content: 'Hi! How can I help?', createdAt: '2026-01-01T00:00:02.000Z' },
    { id: 'a2', role: 'assistant', content: '   ', createdAt: '2026-01-01T00:00:03.000Z' } // empty placeholder
  ]
}

describe('conversationToMarkdown', () => {
  it('emits a title heading and per-turn role blocks', () => {
    const md = conversationToMarkdown(conv)
    expect(md).toContain('# My Chat')
    expect(md).toContain('**You:**')
    expect(md).toContain('Hello there')
    expect(md).toContain('**Sibyl:**')
    expect(md).toContain('Hi! How can I help?')
  })
  it('skips system turns and empty assistant placeholders', () => {
    const md = conversationToMarkdown(conv)
    expect(md).not.toContain('be nice')
    expect(md).not.toContain('**System:**')
    // Only one Sibyl block (the empty placeholder is dropped).
    expect(md.match(/\*\*Sibyl:\*\*/g)).toHaveLength(1)
  })
  it('includes a compaction summary when present', () => {
    const md = conversationToMarkdown({
      ...conv,
      compaction: {
        summary: 'earlier stuff',
        throughMessageId: 'u1',
        foldedCount: 2,
        originalTokens: 100,
        summaryTokens: 10,
        compactedAt: '2026-01-01T00:00:30.000Z'
      }
    })
    expect(md).toContain('earlier stuff')
  })
})

describe('scene attribution', () => {
  const scene: Conversation = {
    id: 'sc',
    title: 'Standoff',
    modelId: 'm1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    cast: ['a', 'b'],
    messages: [
      { id: 'd1', role: 'user', content: 'raise the stakes', createdAt: '', director: true },
      { id: 'b1', role: 'assistant', content: 'I hold the line.', createdAt: '', speakerId: 'a', speakerName: 'Ada' },
      { id: 'b2', role: 'assistant', content: 'Not today.', createdAt: '', speakerId: 'b', speakerName: 'Bo' },
      { id: 'u1', role: 'user', content: 'I step between them.', createdAt: '' }
    ]
  }
  it('labels beats by speaker, director notes as Director, and the human as You', () => {
    const md = conversationToMarkdown(scene)
    expect(md).toContain('**Ada:**')
    expect(md).toContain('**Bo:**')
    expect(md).toContain('**Director:**')
    expect(md).toContain('**You:**')
    expect(md).not.toContain('**Sibyl:**')
  })
})

describe('conversationToText', () => {
  it('renders plain role-prefixed lines without markdown', () => {
    const txt = conversationToText(conv)
    expect(txt).toContain('My Chat')
    expect(txt).toContain('You:')
    expect(txt).toContain('Sibyl:')
    expect(txt).not.toContain('**')
  })
})

describe('buildExport', () => {
  it('selects content and extension per format', () => {
    expect(buildExport(conv, 'json').ext).toBe('json')
    expect(JSON.parse(buildExport(conv, 'json').content).id).toBe('c1')
    expect(buildExport(conv, 'text').ext).toBe('txt')
    expect(buildExport(conv, 'markdown').ext).toBe('md')
  })
})

describe('exportFileBaseName', () => {
  it('produces a filesystem-safe base name', () => {
    expect(exportFileBaseName({ ...conv, title: 'Hello / World: test?' })).toBe('Hello-World-test')
    expect(exportFileBaseName({ ...conv, title: '' })).toBe('conversation')
  })
})
