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
    expect(md).toContain('**Oracle:**')
    expect(md).toContain('Hi! How can I help?')
  })
  it('skips system turns and empty assistant placeholders', () => {
    const md = conversationToMarkdown(conv)
    expect(md).not.toContain('be nice')
    expect(md).not.toContain('**System:**')
    // Only one Oracle block (the empty placeholder is dropped).
    expect(md.match(/\*\*Oracle:\*\*/g)).toHaveLength(1)
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

describe('conversationToText', () => {
  it('renders plain role-prefixed lines without markdown', () => {
    const txt = conversationToText(conv)
    expect(txt).toContain('My Chat')
    expect(txt).toContain('You:')
    expect(txt).toContain('Oracle:')
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
