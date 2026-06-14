import { memo, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { actions, useStore } from '../../store'
import { Markdown } from '../../lib/markdown'
import {
  SparkIcon,
  CopyIcon,
  CheckIcon,
  EditIcon,
  TrashIcon,
  RefreshIcon,
  AlertTriangleIcon
} from '../../lib/icons'

interface Props {
  message: ChatMessage
  streaming: boolean
  /** True for the final visible message — gates the Regenerate action. */
  isLast?: boolean
  /** True when this message is the current in-conversation find match. */
  highlighted?: boolean
}

const HIGHLIGHT = 'rounded-2xl ring-2 ring-oracle-accent/70 ring-offset-2 ring-offset-oracle-bg'

const ACTION_BASE =
  'flex items-center gap-1 text-[11px] text-oracle-muted transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const ACTION = `${ACTION_BASE} hover:text-oracle-text`
const ACTION_DANGER = `${ACTION_BASE} hover:text-red-300`

function MessageImpl({ message, streaming, isLast = false, highlighted = false }: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const generating = useStore((s) => s.engine.state === 'generating')
  const isUser = message.role === 'user'

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

  // --- user message --------------------------------------------------------
  if (isUser) {
    if (editing) {
      return (
        <div className="flex justify-end animate-fade-in">
          <div className="w-full max-w-[80%]">
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
            <div className="mt-1.5 flex justify-end gap-2">
              <button onClick={() => setEditing(false)} className="btn-ghost px-2.5 py-1 text-[12px]">
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={!draft.trim()}
                className="btn-primary px-2.5 py-1 text-[12px] disabled:opacity-40"
              >
                Save & resend
              </button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className={`group flex flex-col items-end animate-fade-in ${highlighted ? HIGHLIGHT : ''}`}>
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-oracle-accent/90 to-oracle-accent-2/90 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-lg shadow-oracle-accent/10">
          <p className="selectable whitespace-pre-wrap">{message.content}</p>
        </div>
        <div className="mt-1.5 flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={copy} className={ACTION}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={startEdit} disabled={generating} className={ACTION}>
            <EditIcon size={12} /> Edit
          </button>
          <button onClick={() => actions.deleteMessage(message.id)} disabled={generating} className={ACTION_DANGER}>
            <TrashIcon size={12} /> Delete
          </button>
        </div>
      </div>
    )
  }

  // --- assistant message ---------------------------------------------------
  return (
    <div className={`group flex gap-3 animate-fade-in ${highlighted ? HIGHLIGHT : ''}`}>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-oracle-accent to-oracle-accent-2 text-white shadow-md shadow-oracle-accent/30">
        <SparkIcon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        {message.content ? (
          <div className={streaming ? 'caret-wrap' : ''}>
            <Markdown source={message.content} />
            {streaming && <span className="caret" />}
          </div>
        ) : message.error ? null : (
          <div className="flex items-center gap-1 py-2">
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-oracle-accent" />
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-oracle-accent [animation-delay:0.2s]" />
            <span className="h-2 w-2 animate-pulse-glow rounded-full bg-oracle-accent [animation-delay:0.4s]" />
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

        {!streaming && (message.content || message.stats || message.error) && (
          <div className="mt-1.5 flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
            {message.content && (
              <button onClick={copy} className={ACTION}>
                {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {isLast && !message.error && (
              <button onClick={() => void actions.regenerate(message.id)} disabled={generating} className={ACTION}>
                <RefreshIcon size={12} /> Regenerate
              </button>
            )}
            <button onClick={() => actions.deleteMessage(message.id)} disabled={generating} className={ACTION_DANGER}>
              <TrashIcon size={12} /> Delete
            </button>
            {message.stats && (
              <span className="text-[11px] text-oracle-muted/70">
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
