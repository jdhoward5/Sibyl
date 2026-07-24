import { useRef, useState, useEffect } from 'react'
import { actions, useStore } from '../../store'
import { estimateTokens, formatTokens } from '@shared/context'
import { isScene } from '@shared/scene'
import { rendererTurnIsBusy } from '@shared/turn'
import { SendIcon, StopIcon, MegaphoneIcon, SpeakerIcon } from '../../lib/icons'

type Mode = 'speak' | 'direct'

export function Composer() {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('speak')
  const ref = useRef<HTMLTextAreaElement>(null)
  const turnOperation = useStore((s) => s.turnOperation)
  const busy = rendererTurnIsBusy(turnOperation)
  const stopping = turnOperation.phase === 'stopping'
  const generating = turnOperation.phase === 'generating' || stopping
  const hasModel = useStore((s) => Boolean(s.engine.modelId))
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const scene = isScene(conv)

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const submit = async (): Promise<void> => {
    const submitted = text
    if (busy || !submitted.trim()) return
    let accepted: boolean
    if (scene) {
      accepted =
        mode === 'direct'
          ? await actions.sceneDirect(submitted)
          : await actions.sceneSpeak(submitted)
    } else {
      accepted = await actions.sendMessage(submitted)
    }
    if (accepted) {
      setText((current) => (current === submitted ? '' : current))
    }
  }

  const placeholder = !hasModel
    ? 'Load a model to start…'
    : scene
      ? mode === 'direct'
        ? 'Direct the scene — out-of-character guidance (e.g. “raise the tension”)…'
        : 'Speak as your character — the next character will respond…'
      : 'Message Sibyl…  (Enter to send, Shift+Enter for newline)'

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto max-w-3xl">
        {scene && (
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-lg border border-sibyl-border bg-sibyl-surface p-0.5">
              <button
                onClick={() => setMode('speak')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                  mode === 'speak' ? 'bg-sibyl-accent-2/15 text-sibyl-accent-2' : 'text-sibyl-muted hover:text-sibyl-text'
                }`}
                title="Join the scene as your own character"
              >
                <SpeakerIcon size={13} /> Speak
              </button>
              <button
                onClick={() => setMode('direct')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                  mode === 'direct' ? 'bg-sibyl-accent/15 text-sibyl-accent' : 'text-sibyl-muted hover:text-sibyl-text'
                }`}
                title="Steer the scene out-of-character"
              >
                <MegaphoneIcon size={13} /> Direct
              </button>
            </div>
            <span className="text-[11px] text-sibyl-muted/70">
              {mode === 'direct'
                ? 'Out-of-character note that steers the next beats.'
                : 'Your line, then a character responds.'}
            </span>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-sibyl-border bg-sibyl-surface p-2 shadow-xl transition-colors focus-within:border-sibyl-accent/60">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="no-drag selectable max-h-[220px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-sibyl-text placeholder:text-sibyl-muted/60 outline-none"
          />
          {generating ? (
            <button
              onClick={() => actions.abortGeneration()}
              disabled={stopping}
              className="btn-surface h-10 w-10 shrink-0 p-0 disabled:opacity-40"
              title={stopping ? 'Stopping…' : 'Stop'}
            >
              <StopIcon size={18} />
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={busy || !text.trim()}
              className={`h-10 w-10 shrink-0 p-0 ${scene && mode === 'direct' ? 'btn-surface' : 'btn-primary'}`}
              title={scene ? (mode === 'direct' ? 'Add director note' : 'Speak') : 'Send'}
            >
              {scene && mode === 'direct' ? <MegaphoneIcon size={18} /> : <SendIcon size={18} />}
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-center gap-2 text-[10.5px] text-sibyl-muted/50">
          <span>Runs entirely on your machine. Sibyl never sends your conversations anywhere.</span>
          {text.trim() && (
            <span className="font-mono text-sibyl-muted/60">· ~{formatTokens(estimateTokens(text))} tokens</span>
          )}
        </div>
      </div>
    </div>
  )
}
