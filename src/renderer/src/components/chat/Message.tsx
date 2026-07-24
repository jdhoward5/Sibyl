import { memo, useState } from 'react'
import type { ChatMessage, PersonaAvatar } from '@shared/types'
import { actions, canSpeak, useStore } from '../../store'
import { Markdown } from '../../lib/markdown'
import { Avatar } from '../persona/Avatar'
import {
  CopyIcon,
  CheckIcon,
  EditIcon,
  TrashIcon,
  RefreshIcon,
  BranchIcon,
  AlertTriangleIcon,
  SpeakerIcon,
  StopIcon,
  MegaphoneIcon
} from '../../lib/icons'

interface Props {
  message: ChatMessage
  streaming: boolean
  /** True for the final visible message — gates the Regenerate action. */
  isLast?: boolean
  /** True when this message is the current in-conversation find match. */
  highlighted?: boolean
  /** Speaker label for assistant turns (persona name, or "Sibyl"). */
  speaker?: string
  /** In a scene: the speaking persona's avatar, shown beside the attribution. */
  avatar?: PersonaAvatar
  /** In a scene: the speaker's accent colour for the attribution label. */
  speakerColor?: string
}

const HIGHLIGHT = 'rounded-lg ring-2 ring-sibyl-accent/70 ring-offset-4 ring-offset-sibyl-bg'

const LABEL = 'font-mono text-[11px] uppercase tracking-[0.08em]'

const ACTION_BASE =
  'flex items-center gap-1 text-[11px] text-sibyl-muted transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const ACTION = `${ACTION_BASE} hover:text-sibyl-text`
const ACTION_DANGER = `${ACTION_BASE} hover:text-red-300`

function MessageImpl({
  message,
  streaming,
  isLast = false,
  highlighted = false,
  speaker = 'Sibyl',
  avatar,
  speakerColor
}: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const generating = useStore((s) => s.engine.state === 'generating')
  const streamStats = useStore((s) => s.streamStats)
  const showSpeak = useStore(canSpeak)
  const speaking = useStore((s) => s.speakingMessageId === message.id)
  const isUser = message.role === 'user'

  // --- director note — out-of-character stage direction --------------------
  if (message.director) {
    if (editing) {
      return (
        <div className="animate-fade-in">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (draft.trim()) {
                  actions.editMessageContent(message.id, draft)
                  setEditing(false)
                }
              } else if (e.key === 'Escape') setEditing(false)
            }}
            rows={2}
            className="input mx-auto block w-full max-w-[520px] resize-none text-center text-[13px]"
          />
        </div>
      )
    }
    return (
      <div className={`group animate-fade-in ${highlighted ? HIGHLIGHT : ''}`}>
        <div className="mx-auto flex max-w-[560px] items-start gap-2 rounded-lg border border-dashed border-sibyl-accent-2/40 bg-sibyl-accent-2/[0.05] px-3.5 py-2 text-center">
          <MegaphoneIcon size={14} className="mt-0.5 shrink-0 text-sibyl-accent-2" />
          <p className="selectable flex-1 whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-sibyl-secondary">
            <span className={`${LABEL} mr-1.5 not-italic text-sibyl-accent-2`}>Director</span>
            {message.content}
          </p>
          <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => {
                setDraft(message.content)
                setEditing(true)
              }}
              disabled={generating}
              className="text-sibyl-muted hover:text-sibyl-text disabled:opacity-40"
              title="Edit note"
            >
              <EditIcon size={12} />
            </button>
            <button
              onClick={() => actions.deleteMessage(message.id)}
              disabled={generating}
              className="text-sibyl-muted hover:text-red-300 disabled:opacity-40"
              title="Delete note"
            >
              <TrashIcon size={12} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Live streaming counters, shown only while this assistant turn is generating.
  const live = streaming && streamStats?.messageId === message.id && streamStats.tokens > 0 ? streamStats : null
  const liveElapsed = live ? (Date.now() - live.startedAt) / 1000 : 0
  const liveTps = live && liveElapsed > 0.05 ? live.tokens / liveElapsed : 0

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const startEdit = (): void => {
    setDraft(message.content)
    setEditing(true)
  }

  const saveEdit = (): void => {
    if (!draft.trim()) return
    setEditing(false)
    void actions.editAndResend(message.id, draft)
  }

  // --- user message — left periwinkle inset, not a bubble ------------------
  if (isUser) {
    if (editing) {
      return (
        <div className="animate-fade-in border-l-2 border-sibyl-accent-2 pl-4">
          <div className={`${LABEL} mb-1.5 text-sibyl-accent-2`}>You</div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                saveEdit()
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            rows={2}
            className="input w-full resize-none text-[15px]"
          />
          <div className="mt-1.5 flex gap-2">
            <button
              onClick={saveEdit}
              disabled={!draft.trim()}
              className="btn-primary px-2.5 py-1 text-[12px] disabled:opacity-40"
            >
              Save & resend
            </button>
            <button onClick={() => setEditing(false)} className="btn-ghost px-2.5 py-1 text-[12px]">
              Cancel
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className={`group animate-fade-in border-l-2 border-sibyl-accent-2 pl-4 ${highlighted ? HIGHLIGHT : ''}`}>
        <div className={`${LABEL} mb-1.5 text-sibyl-accent-2`}>You</div>
        <p className="selectable whitespace-pre-wrap text-[15.5px] italic leading-[1.7] text-sibyl-secondary">
          {message.content}
        </p>
        <div className="mt-2 flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={copy} className={ACTION}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={startEdit} disabled={generating} className={ACTION}>
            <EditIcon size={12} /> Edit
          </button>
          <button onClick={() => actions.branchConversation(message.id)} disabled={generating} className={ACTION}>
            <BranchIcon size={12} /> Branch
          </button>
          <button onClick={() => actions.deleteMessage(message.id)} disabled={generating} className={ACTION_DANGER}>
            <TrashIcon size={12} /> Delete
          </button>
        </div>
      </div>
    )
  }

  // --- assistant message — attributed prose --------------------------------
  return (
    <div className={`group animate-fade-in ${highlighted ? HIGHLIGHT : ''}`}>
      <div className="mb-2 flex items-center gap-2">
        {avatar && <Avatar avatar={avatar} size={22} glow={false} />}
        <span
          className={`${LABEL} ${speakerColor ? '' : 'text-sibyl-accent'}`}
          style={speakerColor ? { color: speakerColor } : undefined}
        >
          {speaker}
        </span>
      </div>
      <div className="min-w-0">
        {message.content ? (
          <div className={streaming ? 'caret-wrap' : ''}>
            <Markdown source={message.content} tintQuotes />
            {streaming && <span className="caret" />}
          </div>
        ) : message.error || message.stopped ? null : (
          <div className="flex items-center gap-1 py-2">
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-sibyl-accent" />
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-sibyl-accent [animation-delay:0.2s]" />
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-sibyl-accent [animation-delay:0.4s]" />
          </div>
        )}

        {live && (
          <div className="mt-1 text-[11px] text-sibyl-muted/60">
            {live.tokens} tokens{liveTps > 0 ? ` · ${liveTps.toFixed(1)} tok/s` : ''}
          </div>
        )}

        {message.error && (
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-200">
            <AlertTriangleIcon size={15} className="shrink-0 text-red-400" />
            <span className="flex-1">{message.error}</span>
            <button
              onClick={() => void actions.regenerate(message.id)}
              disabled={generating}
              className="btn-surface shrink-0 px-2.5 py-1 text-[12px] disabled:opacity-40"
            >
              <RefreshIcon size={13} /> Retry
            </button>
          </div>
        )}

        {message.stopped && (
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12.5px] text-amber-200">
            <StopIcon size={14} className="shrink-0" />
            <span className="flex-1">Stopped — partial response kept</span>
            <button
              onClick={() => void actions.regenerate(message.id)}
              disabled={generating}
              className="btn-surface shrink-0 px-2.5 py-1 text-[12px] disabled:opacity-40"
            >
              <RefreshIcon size={13} /> Retry
            </button>
          </div>
        )}

        {!streaming && (message.content || message.stats || message.error) && (
          <div
            className={`mt-1.5 flex items-center gap-3 transition-opacity group-hover:opacity-100 ${
              speaking ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {message.content && (
              <button onClick={copy} className={ACTION}>
                {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {showSpeak && message.content && (
              <button
                onClick={() =>
                  speaking ? actions.stopSpeaking() : void actions.speakMessage(message.id, message.content)
                }
                className={ACTION}
                title={speaking ? 'Stop speaking' : 'Read aloud'}
              >
                {speaking ? <StopIcon size={12} /> : <SpeakerIcon size={12} />}
                {speaking ? 'Stop' : 'Speak'}
              </button>
            )}
            {isLast && !message.error && (
              <button onClick={() => void actions.regenerate(message.id)} disabled={generating} className={ACTION}>
                <RefreshIcon size={12} /> Regenerate
              </button>
            )}
            <button onClick={() => actions.branchConversation(message.id)} disabled={generating} className={ACTION}>
              <BranchIcon size={12} /> Branch
            </button>
            <button onClick={() => actions.deleteMessage(message.id)} disabled={generating} className={ACTION_DANGER}>
              <TrashIcon size={12} /> Delete
            </button>
            {message.stats && (
              <span className="text-[11px] text-sibyl-muted/70">
                {message.stats.completionTokens} tokens · {message.stats.tokensPerSecond.toFixed(1)} tok/s
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const Message = memo(MessageImpl)
