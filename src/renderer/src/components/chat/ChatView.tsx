import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@shared/types'
import { actions, useStore } from '../../store'
import { formatTokens } from '@shared/context'
import { ConversationList } from './ConversationList'
import { Message } from './Message'
import { Composer } from './Composer'
import { ContextMeter } from './ContextMeter'
import { ConversationSettingsDrawer } from './ConversationSettingsDrawer'
import { ModelPicker } from '../common/ModelPicker'
import {
  SparkIcon,
  CompassIcon,
  CompressIcon,
  AlertTriangleIcon,
  SearchIcon,
  SlidersIcon,
  ChevronRight,
  XIcon
} from '../../lib/icons'

function EmptyState() {
  const hasModel = useStore((s) => Boolean(s.engine.modelId))
  const modelCount = useStore((s) => s.installedModels.length)
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sibyl-accent to-sibyl-accent-2 text-white shadow-2xl shadow-sibyl-accent/30">
        <SparkIcon size={34} />
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-sibyl-text">Ask Sibyl</h2>
      <p className="mb-6 max-w-md text-[14px] leading-relaxed text-sibyl-muted">
        {hasModel
          ? 'Your model is loaded and ready. Type a message below to begin a private, on-device conversation.'
          : modelCount > 0
            ? 'Select a model from the picker above to load it onto your GPU, then start chatting.'
            : 'You have no models yet. Head to Discover to download a chat model from Hugging Face.'}
      </p>
      {modelCount === 0 && (
        <button onClick={() => actions.setView('discover')} className="btn-primary">
          <CompassIcon size={16} /> Discover models
        </button>
      )}
    </div>
  )
}

/** Banner shown when the next reply may not fit the remaining context window. */
function OverflowBanner() {
  const usage = useStore((s) => s.contextUsage)
  const compacting = useStore((s) => s.compacting)
  const generating = useStore((s) => s.engine.state === 'generating')
  const autoCompact = useStore((s) => s.settings?.context.autoCompact ?? false)
  if (!usage || !usage.willOverflow) return null
  return (
    <div className="mx-auto mt-3 flex max-w-3xl items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-[12.5px] text-amber-200">
      <AlertTriangleIcon size={16} className="shrink-0 text-amber-400" />
      <span className="flex-1">
        The context window is nearly full. The next reply may be truncated.{' '}
        {autoCompact
          ? 'Older messages will be summarized automatically on your next send.'
          : 'Compact the conversation to free up space.'}
      </span>
      <button
        onClick={() => void actions.compact()}
        disabled={compacting || generating}
        className="btn-surface shrink-0 px-2.5 py-1 text-[12px] disabled:opacity-40"
      >
        <CompressIcon size={13} /> {compacting ? 'Compacting…' : 'Compact now'}
      </button>
    </div>
  )
}

/** Divider marking where older turns have been folded into a summary. */
function CompactionDivider({ conversation }: { conversation: Conversation }) {
  const c = conversation.compaction
  if (!c) return null
  return (
    <div
      className="my-1 flex items-center gap-2 text-[11.5px] text-sibyl-muted/80"
      title={c.summary}
    >
      <div className="h-px flex-1 bg-sibyl-border/60" />
      <CompressIcon size={12} />
      <span>
        {c.foldedCount} earlier {c.foldedCount === 1 ? 'message' : 'messages'} summarized
        {c.originalTokens > 0 && (
          <> · {formatTokens(c.originalTokens)} → {formatTokens(c.summaryTokens)} tokens</>
        )}
      </span>
      <div className="h-px flex-1 bg-sibyl-border/60" />
    </div>
  )
}

export function ChatView() {
  const conversation = useStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  )
  const generating = useStore((s) => s.engine.state === 'generating')
  const scrollRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  const messages = conversation?.messages ?? []
  const lastLen = messages[messages.length - 1]?.content.length ?? 0

  // Keep the view pinned to the latest content while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages.length, lastLen])

  const visible = messages.filter((m) => m.role !== 'system')
  // Index (within `visible`) of the last message folded into the summary, if any.
  const through = conversation?.compaction?.throughMessageId
  const foldedThroughIdx = through ? visible.findIndex((m) => m.id === through) : -1

  // In-conversation find: ids of messages containing the query, with a current match.
  const fq = findQuery.trim().toLowerCase()
  const matchIds = fq ? visible.filter((m) => m.content.toLowerCase().includes(fq)).map((m) => m.id) : []
  const safeIdx = matchIds.length ? Math.min(findIdx, matchIds.length - 1) : 0
  const currentMatchId = matchIds[safeIdx] ?? null

  // Ctrl/⌘+F opens find; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFindOpen(true)
        setTimeout(() => findInputRef.current?.focus(), 0)
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen])

  // Scroll the current match into view.
  useEffect(() => {
    if (!findOpen || !currentMatchId) return
    document.getElementById(`msg-${currentMatchId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [findOpen, currentMatchId])

  const stepMatch = (dir: number): void => {
    if (!matchIds.length) return
    setFindIdx((i) => (Math.min(i, matchIds.length - 1) + dir + matchIds.length) % matchIds.length)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ConversationList />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-sibyl-border/60 px-4">
          <ModelPicker />
          <div className="flex min-w-0 items-center gap-3">
            <ContextMeter />
            {conversation && (
              <>
                <span className="hidden truncate text-[13px] font-medium text-sibyl-muted lg:inline">
                  {conversation.title}
                </span>
                <button
                  onClick={() => {
                    setFindOpen((o) => !o)
                    setTimeout(() => findInputRef.current?.focus(), 0)
                  }}
                  className="btn-ghost h-8 w-8 shrink-0 p-0"
                  title="Find in conversation (Ctrl+F)"
                >
                  <SearchIcon size={16} />
                </button>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="btn-ghost relative h-8 w-8 shrink-0 p-0"
                  title="Conversation settings"
                >
                  <SlidersIcon size={16} className={conversation.overrides ? 'text-sibyl-accent' : ''} />
                  {conversation.overrides && (
                    <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sibyl-accent" />
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {findOpen && conversation && (
          <div className="flex shrink-0 items-center gap-2 border-b border-sibyl-border/60 bg-sibyl-surface/40 px-4 py-2">
            <SearchIcon size={14} className="shrink-0 text-sibyl-muted" />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value)
                setFindIdx(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepMatch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  setFindOpen(false)
                }
              }}
              placeholder="Find in conversation…"
              className="input h-7 flex-1 text-[12.5px]"
            />
            <span className="shrink-0 font-mono text-[11.5px] text-sibyl-muted">
              {matchIds.length ? `${safeIdx + 1}/${matchIds.length}` : '0/0'}
            </span>
            <button
              onClick={() => stepMatch(-1)}
              disabled={!matchIds.length}
              className="btn-ghost h-7 w-7 p-0 disabled:opacity-40"
              title="Previous match (Shift+Enter)"
            >
              <ChevronRight size={15} className="-rotate-90" />
            </button>
            <button
              onClick={() => stepMatch(1)}
              disabled={!matchIds.length}
              className="btn-ghost h-7 w-7 p-0 disabled:opacity-40"
              title="Next match (Enter)"
            >
              <ChevronRight size={15} className="rotate-90" />
            </button>
            <button onClick={() => setFindOpen(false)} className="btn-ghost h-7 w-7 p-0" title="Close">
              <XIcon size={15} />
            </button>
          </div>
        )}

        {!conversation || visible.length === 0 ? (
          <EmptyState />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <OverflowBanner />
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
              {visible.map((m, i) => (
                <div key={m.id} className="contents">
                  <div
                    id={`msg-${m.id}`}
                    className={foldedThroughIdx >= 0 && i <= foldedThroughIdx ? 'opacity-45' : ''}
                  >
                    <Message
                      message={m}
                      streaming={generating && i === visible.length - 1 && m.role === 'assistant'}
                      isLast={i === visible.length - 1}
                      highlighted={m.id === currentMatchId}
                    />
                  </div>
                  {i === foldedThroughIdx && conversation && (
                    <CompactionDivider conversation={conversation} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <Composer />
      </div>

      {settingsOpen && conversation && (
        <ConversationSettingsDrawer
          key={conversation.id}
          conversation={conversation}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
