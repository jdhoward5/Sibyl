import { useState } from 'react'
import type { Conversation, GenerationOptions } from '@shared/types'
import { actions, useStore } from '../../store'
import { Slider, Toggle } from '../common/controls'
import { XIcon, DownloadIcon } from '../../lib/icons'

interface Props {
  conversation: Conversation
  onClose: () => void
}

/**
 * Right-side drawer for per-conversation overrides (system prompt + generation
 * params) plus export. Seeded from the conversation's current overrides on mount;
 * ChatView keys it by conversation id so switching chats remounts it.
 */
export function ConversationSettingsDrawer({ conversation, onClose }: Props) {
  const settings = useStore((s) => s.settings)
  const [systemPrompt, setSystemPrompt] = useState(conversation.overrides?.systemPrompt ?? '')
  const [genOn, setGenOn] = useState(Boolean(conversation.overrides?.generation))
  const [gen, setGen] = useState<GenerationOptions>(
    conversation.overrides?.generation ?? settings?.generation ?? {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      maxTokens: 2048,
      repeatPenalty: 1.1
    }
  )

  if (!settings) return null

  const save = (): void => {
    void actions.setConversationOverrides(conversation.id, {
      systemPrompt: systemPrompt.trim() || undefined,
      generation: genOn ? gen : undefined
    })
    onClose()
  }

  const clearAll = (): void => {
    void actions.setConversationOverrides(conversation.id, undefined)
    onClose()
  }

  const setG = (patch: Partial<GenerationOptions>): void => setGen((g) => ({ ...g, ...patch }))

  return (
    <div className="no-drag fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md animate-fade-in flex-col border-l border-sibyl-border bg-sibyl-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-sibyl-border/60 p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-sibyl-text">Conversation settings</h2>
            <p className="truncate text-[12.5px] text-sibyl-muted" title={conversation.title}>
              {conversation.title}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost h-8 w-8 p-0">
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-col gap-5">
            {/* System prompt override */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[13px] font-medium text-sibyl-text">System prompt</label>
                {settings.promptPresets.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const p = settings.promptPresets.find((x) => x.id === e.target.value)
                      if (p) setSystemPrompt(p.prompt)
                    }}
                    className="input h-7 w-auto px-2 py-0 text-[12px]"
                  >
                    <option value="">Apply preset…</option>
                    {settings.promptPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                placeholder={`Leave empty to use the global system prompt:\n${settings.load.systemPrompt}`}
                className="input resize-none text-[13px]"
              />
            </div>

            {/* Generation override */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <Toggle
                  label="Override generation settings"
                  desc="Use custom sampling parameters for this conversation only."
                  checked={genOn}
                  onChange={setGenOn}
                />
              </div>
              {genOn && settings.generationProfiles.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const p = settings.generationProfiles.find((x) => x.id === e.target.value)
                    if (p) setGen((g) => ({ ...p.options, stopSequences: g.stopSequences }))
                  }}
                  className="input h-8 w-full px-2 text-[12px]"
                >
                  <option value="">Apply profile…</option>
                  {settings.generationProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <Slider label="Temperature" value={gen.temperature} min={0} max={2} step={0.05} disabled={!genOn}
                onChange={(v) => setG({ temperature: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Top-P" value={gen.topP} min={0} max={1} step={0.01} disabled={!genOn}
                onChange={(v) => setG({ topP: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Top-K" value={gen.topK} min={0} max={100} step={1} disabled={!genOn}
                onChange={(v) => setG({ topK: v })} />
              <Slider label="Min-P" value={gen.minP} min={0} max={0.5} step={0.01} disabled={!genOn}
                onChange={(v) => setG({ minP: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Repeat penalty" value={gen.repeatPenalty} min={1} max={1.5} step={0.01} disabled={!genOn}
                onChange={(v) => setG({ repeatPenalty: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Max response tokens" value={gen.maxTokens} min={256} max={8192} step={256} disabled={!genOn}
                onChange={(v) => setG({ maxTokens: v })} />
            </div>

            {/* Export */}
            <div>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-sibyl-muted">Export</h3>
              <div className="flex gap-2">
                {(['markdown', 'json', 'text'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => void actions.exportConversation(conversation.id, fmt)}
                    className="btn-surface flex-1 px-2.5 py-2 text-[12px] capitalize"
                  >
                    <DownloadIcon size={13} /> {fmt === 'markdown' ? 'Markdown' : fmt === 'json' ? 'JSON' : 'Text'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-sibyl-border/60 p-4">
          <button onClick={clearAll} className="btn-ghost px-3 py-2 text-[12.5px]">
            Reset to global
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost px-3 py-2 text-[12.5px]">
              Cancel
            </button>
            <button onClick={save} className="btn-primary px-4 py-2 text-[12.5px]">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
