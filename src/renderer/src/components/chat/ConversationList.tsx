import { useState } from 'react'
import { actions, useStore } from '../../store'
import { findPersona } from '@shared/personas'
import { isScene, sceneCast } from '@shared/scene'
import { PlusIcon, TrashIcon, EditIcon, SearchIcon } from '../../lib/icons'

/** First message snippet around a match, for the search results. */
function matchSnippet(content: string, q: string): string | null {
  const i = content.toLowerCase().indexOf(q)
  if (i < 0) return null
  const start = Math.max(0, i - 24)
  return (start > 0 ? '…' : '') + content.slice(start, i + q.length + 36).trim() + '…'
}

/** Compact relative time for the thread meta line. */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString()
}

export function ConversationList() {
  const conversations = useStore((s) => s.conversations)
  const activeId = useStore((s) => s.activeConversationId)
  const personas = useStore((s) => s.settings?.personas ?? [])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = q
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content.toLowerCase().includes(q))
      )
    : conversations

  return (
    <div className="flex w-[262px] shrink-0 flex-col border-r border-sibyl-border/60 bg-sibyl-sunken">
      <div className="flex flex-col gap-2 p-3">
        <button
          onClick={() => actions.openPersonaPicker()}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-sibyl-accent/35 bg-sibyl-accent/[0.07] text-[13px] font-semibold text-sibyl-accent transition-colors hover:bg-sibyl-accent/15"
        >
          <PlusIcon size={15} /> New thread
        </button>
        <div className="relative">
          <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sibyl-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads…"
            className="input h-8 w-full pl-8 text-[12.5px]"
          />
        </div>
      </div>
      <div className="px-4 pb-2 pt-1 eyebrow">// Threads</div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        {conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-sibyl-muted/70">No threads yet.</p>
        )}
        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-sibyl-muted/70">No threads match “{query.trim()}”.</p>
        )}
        {filtered.map((c) => {
          const titleMatches = q ? c.title.toLowerCase().includes(q) : true
          const snippet =
            q && !titleMatches ? (c.messages.map((m) => matchSnippet(m.content, q)).find(Boolean) ?? null) : null
          const active = c.id === activeId
          const persona = findPersona(personas, c.personaId)
          const scene = isScene(c)
          const lead = scene
            ? `Scene · ${sceneCast(c, personas).length} cast`
            : (persona?.name ?? 'Blank')
          const turns = scene
            ? c.messages.filter((m) => m.role === 'assistant').length
            : c.messages.filter((m) => m.role === 'user').length
          const turnLabel = scene
            ? `${turns} ${turns === 1 ? 'beat' : 'beats'}`
            : `${turns} ${turns === 1 ? 'turn' : 'turns'}`
          const meta = [lead, turnLabel, relTime(c.updatedAt)].join(' · ')
          return (
            <div
              key={c.id}
              onClick={() => actions.selectConversation(c.id)}
              className={`group relative mb-0.5 cursor-pointer rounded-md px-3 py-2.5 transition-colors ${
                active ? 'bg-sibyl-surface-2' : 'hover:bg-sibyl-surface'
              }`}
            >
              {active && <span className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded bg-sibyl-accent" />}
              {editingId === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    actions.renameConversation(c.id, draft)
                    setEditingId(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      actions.renameConversation(c.id, draft)
                      setEditingId(null)
                    } else if (e.key === 'Escape') {
                      setEditingId(null)
                    }
                  }}
                  className="input h-6 w-full px-1.5 py-0 text-[13px]"
                />
              ) : (
                <div className="min-w-0">
                  <div className={`truncate text-[13px] ${active ? 'font-semibold text-sibyl-text' : 'font-medium text-sibyl-secondary'}`}>
                    {c.title}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-sibyl-muted">{meta}</div>
                  {snippet && <div className="mt-0.5 truncate text-[11px] text-sibyl-muted/80">{snippet}</div>}
                </div>
              )}
              <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(c.id)
                    setDraft(c.title)
                  }}
                  className="rounded bg-sibyl-surface-2 p-1 text-sibyl-muted hover:text-sibyl-text"
                  title="Rename"
                >
                  <EditIcon size={13} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void actions.deleteConversation(c.id)
                  }}
                  className="rounded bg-sibyl-surface-2 p-1 text-sibyl-muted hover:text-red-300"
                  title="Delete"
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
