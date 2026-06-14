import { useState } from 'react'
import { actions, useStore } from '../../store'
import { PlusIcon, TrashIcon, ChatIcon, EditIcon, SearchIcon } from '../../lib/icons'

/** First message snippet around a match, for the search results. */
function matchSnippet(content: string, q: string): string | null {
  const i = content.toLowerCase().indexOf(q)
  if (i < 0) return null
  const start = Math.max(0, i - 24)
  return (start > 0 ? '…' : '') + content.slice(start, i + q.length + 36).trim() + '…'
}

export function ConversationList() {
  const conversations = useStore((s) => s.conversations)
  const activeId = useStore((s) => s.activeConversationId)
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
    <div className="flex w-[260px] shrink-0 flex-col border-r border-oracle-border/60 bg-oracle-bg">
      <div className="flex flex-col gap-2 p-3">
        <button onClick={() => actions.newConversation()} className="btn-primary w-full">
          <PlusIcon size={16} /> New chat
        </button>
        <div className="relative">
          <SearchIcon
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-oracle-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="input h-8 w-full pl-8 text-[12.5px]"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-oracle-muted/70">
            No conversations yet.
          </p>
        )}
        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-oracle-muted/70">
            No conversations match “{query.trim()}”.
          </p>
        )}
        {filtered.map((c) => {
          const titleMatches = q ? c.title.toLowerCase().includes(q) : true
          const snippet =
            q && !titleMatches
              ? (c.messages.map((m) => matchSnippet(m.content, q)).find(Boolean) ?? null)
              : null
          const active = c.id === activeId
          return (
            <div
              key={c.id}
              onClick={() => actions.selectConversation(c.id)}
              className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                active ? 'bg-oracle-surface-2' : 'hover:bg-oracle-surface'
              }`}
            >
              <ChatIcon size={15} className="shrink-0 text-oracle-muted" />
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
                  className="input h-6 flex-1 px-1.5 py-0 text-[13px]"
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-oracle-text">{c.title}</div>
                  {snippet && (
                    <div className="truncate text-[11px] text-oracle-muted/80">{snippet}</div>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(c.id)
                    setDraft(c.title)
                  }}
                  className="rounded p-1 text-oracle-muted hover:text-oracle-text"
                  title="Rename"
                >
                  <EditIcon size={13} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void actions.deleteConversation(c.id)
                  }}
                  className="rounded p-1 text-oracle-muted hover:text-red-300"
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
