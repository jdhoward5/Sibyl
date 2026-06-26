// Pure helpers that render a conversation to an exportable document. No node /
// electron imports — safe to load anywhere (and unit-tested like format.ts).

import type { ChatMessage, Conversation } from './types'

export type ExportFormat = 'markdown' | 'json' | 'text'

/**
 * Who a message is attributed to in an export. Scene beats carry their own
 * speaker; director notes are out-of-character; otherwise it's the writer ("You")
 * or the assistant ("Sibyl").
 */
const speakerLabel = (m: ChatMessage): string => {
  if (m.director) return 'Director'
  if (m.role === 'assistant') return m.speakerName?.trim() || 'Sibyl'
  return m.role === 'user' ? 'You' : 'System'
}

/** Turns rendered into the document — skip the empty assistant placeholder + system turns. */
function exportableMessages(conv: Conversation): ChatMessage[] {
  return conv.messages.filter((m) => m.role !== 'system' && m.content.trim())
}

export function conversationToMarkdown(conv: Conversation): string {
  const lines: string[] = [`# ${conv.title || 'Conversation'}`, '']
  const summary = conv.compaction?.summary?.trim()
  if (summary) lines.push(`> **Earlier conversation summary:** ${summary}`, '')
  for (const m of exportableMessages(conv)) {
    lines.push(`**${speakerLabel(m)}:**`, '', m.content.trim(), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

export function conversationToText(conv: Conversation): string {
  const lines: string[] = [conv.title || 'Conversation', '']
  const summary = conv.compaction?.summary?.trim()
  if (summary) lines.push(`[Earlier conversation summary] ${summary}`, '')
  for (const m of exportableMessages(conv)) {
    lines.push(`${speakerLabel(m)}:`, m.content.trim(), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Render a conversation in the requested format, with the file extension to use. */
export function buildExport(conv: Conversation, format: ExportFormat): { content: string; ext: string } {
  switch (format) {
    case 'json':
      return { content: JSON.stringify(conv, null, 2) + '\n', ext: 'json' }
    case 'text':
      return { content: conversationToText(conv), ext: 'txt' }
    case 'markdown':
    default:
      return { content: conversationToMarkdown(conv), ext: 'md' }
  }
}

/** Filesystem-safe base filename derived from a conversation title. */
export function exportFileBaseName(conv: Conversation): string {
  const base = (conv.title || 'conversation')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return base || 'conversation'
}
