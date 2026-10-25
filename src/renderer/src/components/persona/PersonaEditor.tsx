import { useState } from 'react'
import type { GenerationOptions, Persona, PersonaRelationship } from '@shared/types'
import { actions, uid, useStore } from '../../store'
import { estimateTokens } from '@shared/context'
import { gradientFor, initialsOf } from '@shared/personas'
import { Avatar } from './Avatar'
import { Slider } from '../common/controls'
import { XIcon, PlusIcon, TrashIcon } from '../../lib/icons'
import { useDialogFocus } from '../../lib/useDialogFocus'

/** Sampling defaults for a fresh persona — roleplay tends to want the creative profile. */
const CREATIVE: GenerationOptions = {
  temperature: 0.9,
  topP: 0.92,
  topK: 60,
  minP: 0.03,
  maxTokens: 2048,
  repeatPenalty: 1.08
}

function blankPersona(): Persona {
  const id = uid()
  return {
    id,
    name: '',
    role: '',
    brief: '',
    greeting: '',
    avatar: { monogram: '?', gradient: gradientFor(id) },
    voiceTags: [],
    generation: undefined
    ,schemaVersion: 2
    ,version: 1
    ,publicDescription: ''
    ,privateMotivations: []
    ,secrets: []
    ,behavioralConstraints: []
    ,speechGuidance: ''
    ,relationships: []
  }
}

const editableLines = (value: string): string[] => value.split('\n')

const normalizedLines = (value: string[] | undefined): string[] | undefined =>
  value?.map((item) => item.trim()).filter(Boolean)

interface Props {
  /** Persona to open in the form; omit/null to start a new one. */
  initialPersonaId?: string | null
  /** When set, "Apply" also points this thread at the (saved) persona. */
  conversationId?: string | null
  onClose: () => void
}

/**
 * Right-side drawer that edits a persona in the library: name, role, character
 * brief, voice tags, opening message and per-persona sampling. The library
 * switcher row hops between saved personas (or starts a new one).
 */
export function PersonaEditor({ initialPersonaId, conversationId, onClose }: Props) {
  const personas = useStore((s) => s.settings?.personas ?? [])
  const installedVoices = useStore((s) => s.installedVoices)
  const conversation = useStore((s) =>
    conversationId
      ? s.conversations.find((item) => item.id === conversationId)
      : undefined
  )
  const personaSnapshot = conversation?.personaSnapshot
  const frozen = [
    ...(personaSnapshot ? [personaSnapshot] : []),
    ...(conversation?.castSnapshots ?? [])
  ].find((snapshot) => snapshot.sourcePersonaId === initialPersonaId)?.persona
  const initial = personas.find((p) => p.id === initialPersonaId) ?? frozen ?? null
  const [draft, setDraft] = useState<Persona>(initial ? structuredClone(initial) : blankPersona())
  const [samplingOn, setSamplingOn] = useState(Boolean(initial?.generation))
  const [tagDraft, setTagDraft] = useState('')
  const [showDelete, setShowDelete] = useState(false)
  const [replacementId, setReplacementId] = useState('')
  const [saving, setSaving] = useState(false)
  const close = (): void => { if (!saving) onClose() }
  const dialogRef = useDialogFocus<HTMLDivElement>(close)

  const set = (patch: Partial<Persona>): void => setDraft((d) => ({ ...d, ...patch }))
  const setName = (name: string): void =>
    setDraft((d) => ({ ...d, name, avatar: { ...d.avatar, monogram: initialsOf(name || '?') } }))
  const setGen = (patch: Partial<GenerationOptions>): void =>
    setDraft((d) => ({ ...d, generation: { ...(d.generation ?? CREATIVE), ...patch } }))

  const loadPersona = (p: Persona | null): void => {
    const next = p ? structuredClone(p) : blankPersona()
    setDraft(next)
    setSamplingOn(Boolean(next.generation))
  }

  const addTag = (): void => {
    const t = tagDraft.trim()
    if (t && !draft.voiceTags.includes(t)) set({ voiceTags: [...draft.voiceTags, t] })
    setTagDraft('')
  }

  const canSave = draft.name.trim().length > 0
  // Whether the persona currently in the form already exists in the library
  // (the library switcher can change `draft` away from the one opened at mount).
  const isSaved = personas.some((p) => p.id === draft.id)

  const commit = async (apply: boolean): Promise<void> => {
    if (!canSave || saving) return
    const persona: Persona = {
      ...draft,
      name: draft.name.trim(),
      role: draft.role.trim(),
      brief: draft.brief.trim(),
      greeting: draft.greeting?.trim() || undefined,
      avatar: { ...draft.avatar, monogram: initialsOf(draft.name) },
      generation: samplingOn ? (draft.generation ?? CREATIVE) : undefined,
      privateMotivations: normalizedLines(draft.privateMotivations),
      secrets: normalizedLines(draft.secrets),
      behavioralConstraints: normalizedLines(draft.behavioralConstraints),
      relationships: draft.relationships
        ?.filter((relationship) => relationship.personaId && relationship.summary.trim())
        .map((relationship) => ({ ...relationship, summary: relationship.summary.trim() }))
    }
    setSaving(true)
    try {
      const saved = await actions.savePersona(
        persona,
        apply ? (conversationId ?? undefined) : undefined
      )
      if (saved) onClose()
    } finally {
      setSaving(false)
    }
  }

  const briefTokens = estimateTokens(draft.brief)
  const identityTokens = estimateTokens(
    [
      draft.publicDescription,
      ...(draft.privateMotivations ?? []),
      ...(draft.secrets ?? []),
      ...(draft.behavioralConstraints ?? []),
      draft.speechGuidance,
      ...(draft.relationships ?? []).map((relationship) => relationship.summary)
    ].filter(Boolean).join('\n')
  )
  const impact = isSaved ? actions.personaDeletionImpact(draft.id) : null

  return (
    <div className="no-drag fixed bottom-0 left-0 right-0 top-10 z-40 flex justify-end">
      <div aria-hidden className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="persona-editor-title"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[480px] animate-fade-in flex-col border-l border-sibyl-border bg-sibyl-sunken shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-sibyl-border/60 px-5 py-4">
          <div>
            <div className="eyebrow text-sibyl-accent">Character</div>
            <h2 id="persona-editor-title" className="display-title mt-1 text-[19px]">
              {isSaved ? 'Edit character' : 'New character'}
            </h2>
          </div>
          <button
            data-dialog-initial-focus
            onClick={close}
            disabled={saving}
            className="btn-ghost h-8 w-8 p-0"
            aria-label="Close character editor"
          >
            <XIcon size={16} />
          </button>
        </div>

        <fieldset disabled={saving} className="contents">
        {/* library switcher */}
        <div className="border-b border-sibyl-border/60 px-5 py-3.5">
          <div className="eyebrow mb-2.5 text-[10.5px]">Library</div>
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {personas.map((p) => (
              <button key={p.id} onClick={() => loadPersona(p)} title={p.name} className="shrink-0">
                <Avatar
                  avatar={p.avatar}
                  size={34}
                  glow={false}
                  ring={p.id === draft.id ? 'rgb(var(--sibyl-accent))' : undefined}
                />
              </button>
            ))}
            <button
              onClick={() => loadPersona(null)}
              title="New character"
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-dashed border-sibyl-border text-sibyl-muted hover:text-sibyl-text"
            >
              <PlusIcon size={14} />
            </button>
          </div>
        </div>

        {/* form */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-[18px]">
            <div className="flex items-center gap-3">
              <Avatar avatar={draft.avatar} size={52} />
              <div className="flex-1">
                <div className="eyebrow mb-1.5 text-[10.5px]">Name</div>
                <input value={draft.name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Character name" />
              </div>
            </div>

            <div>
              <div className="eyebrow mb-1.5 text-[10.5px]">Role · one line</div>
              <input
                value={draft.role}
                onChange={(e) => set({ role: e.target.value })}
                className="input"
                placeholder="e.g. Caravan guard escorting the player"
              />
            </div>

            <div className="rounded-lg border border-sibyl-border/60 bg-sibyl-surface/40 p-3.5">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow text-[10.5px]">Identity & private context</span>
                <span className="font-mono text-[10px] text-sibyl-faint">
                  ~{identityTokens} / 3,000 tok
                </span>
              </div>
              <label className="mb-1 block text-[11px] text-sibyl-muted">Public description</label>
              <textarea
                value={draft.publicDescription ?? ''}
                onChange={(e) => set({ publicDescription: e.target.value })}
                rows={2}
                className="input mb-3 resize-none text-[12.5px]"
                placeholder="What every character may know or observe."
              />
              {([
                ['Private motivations · one per line', 'privateMotivations'],
                ['Secrets · one per line', 'secrets'],
                ['Behavioral constraints · one per line', 'behavioralConstraints']
              ] as const).map(([label, field]) => (
                <div key={field} className="mb-3">
                  <label className="mb-1 block text-[11px] text-sibyl-muted">{label}</label>
                  <textarea
                    aria-label={label.split(' ·')[0]}
                    value={(draft[field] ?? []).join('\n')}
                    onChange={(e) => set({ [field]: editableLines(e.target.value) })}
                    rows={2}
                    className="input resize-none text-[12.5px]"
                  />
                </div>
              ))}
              <label className="mb-1 block text-[11px] text-sibyl-muted">Speech & style guidance</label>
              <textarea
                value={draft.speechGuidance ?? ''}
                onChange={(e) => set({ speechGuidance: e.target.value })}
                rows={2}
                className="input resize-none text-[12.5px]"
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="eyebrow text-[10.5px]">Relationships</span>
                <button
                  onClick={() =>
                    set({
                      relationships: [
                        ...(draft.relationships ?? []),
                        {
                          personaId: personas.find((persona) => persona.id !== draft.id)?.id ?? '',
                          summary: '',
                          visibility: 'private'
                        }
                      ]
                    })
                  }
                  className="btn-ghost px-2 py-1 text-[11px]"
                >
                  <PlusIcon size={11} /> Add
                </button>
              </div>
              <div className="space-y-2">
                {(draft.relationships ?? []).map((relationship, index) => {
                  const update = (patch: Partial<PersonaRelationship>): void =>
                    set({
                      relationships: draft.relationships!.map((item, i) =>
                        i === index ? { ...item, ...patch } : item
                      )
                    })
                  return (
                    <div key={`${relationship.personaId}-${index}`} className="rounded-lg border border-sibyl-border/60 p-2">
                      <div className="mb-2 flex gap-2">
                        <select
                          value={relationship.personaId}
                          onChange={(e) => update({ personaId: e.target.value })}
                          className="input h-8 flex-1 py-0 text-[12px]"
                        >
                          <option value="">Choose character…</option>
                          {personas.filter((persona) => persona.id !== draft.id).map((persona) => (
                            <option key={persona.id} value={persona.id}>{persona.name}</option>
                          ))}
                        </select>
                        <select
                          value={relationship.visibility}
                          onChange={(e) => update({ visibility: e.target.value as 'public' | 'private' })}
                          className="input h-8 w-24 py-0 text-[12px]"
                        >
                          <option value="private">Private</option>
                          <option value="public">Public</option>
                        </select>
                        <button
                          onClick={() =>
                            set({
                              relationships: draft.relationships!.filter((_, i) => i !== index)
                            })
                          }
                          className="btn-ghost h-8 w-8 p-0"
                        >
                          <TrashIcon size={12} />
                        </button>
                      </div>
                      <input
                        value={relationship.summary}
                        onChange={(e) => update({ summary: e.target.value })}
                        className="input text-[12.5px]"
                        placeholder="How this character sees the relationship"
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="eyebrow text-[10.5px]">Character brief · system prompt</span>
                <span className="font-mono text-[10px] text-sibyl-faint">~{briefTokens} tok</span>
              </div>
              <textarea
                value={draft.brief}
                onChange={(e) => set({ brief: e.target.value })}
                rows={5}
                placeholder="Who is this character? How do they speak and behave?"
                className="input resize-none text-[13px] leading-[1.6] focus:ring-2 focus:ring-sibyl-accent/10"
              />
            </div>

            <div>
              <div className="eyebrow mb-1.5 text-[10.5px]">Voice</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {draft.voiceTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => set({ voiceTags: draft.voiceTags.filter((x) => x !== t) })}
                    title="Remove tag"
                    className="flex items-center gap-1 rounded-full border border-sibyl-accent-2/30 bg-sibyl-accent-2/10 px-2.5 py-1 font-mono text-[10.5px] text-sibyl-accent-2"
                  >
                    {t} <XIcon size={10} />
                  </button>
                ))}
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                  onBlur={addTag}
                  placeholder="+ tag"
                  className="w-[72px] rounded-full border border-dashed border-sibyl-border bg-transparent px-2.5 py-1 font-mono text-[10.5px] text-sibyl-muted outline-none focus:border-sibyl-accent/40"
                />
              </div>
              <div className="mt-2 flex gap-2">
                <label htmlFor="persona-voice" className="sr-only">
                  Character voice
                </label>
                <select
                  id="persona-voice"
                  value={draft.voice?.voiceId ?? ''}
                  onChange={(e) => set({ voice: { ...draft.voice, voiceId: e.target.value || undefined } })}
                  className="input flex-1 text-[12px]"
                >
                  <option value="">Use scene or global voice</option>
                  {installedVoices.map((voice) => (
                    <option
                      key={voice.id}
                      value={voice.id}
                      disabled={Boolean(
                        voice.availability && voice.availability !== 'available'
                      )}
                    >
                      {voice.name}
                      {voice.availability && voice.availability !== 'available'
                        ? ` · ${voice.availability}`
                        : ''}
                    </option>
                  ))}
                </select>
                <label htmlFor="persona-voice-rate" className="sr-only">
                  Character speaking rate
                </label>
                <input
                  id="persona-voice-rate"
                  type="number"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={draft.voice?.rate ?? 1}
                  onChange={(e) => set({ voice: { ...draft.voice, rate: Number(e.target.value) } })}
                  className="input w-20 text-[12px]"
                  title="Speech rate"
                />
              </div>
            </div>

            <div>
              <div className="eyebrow mb-1.5 text-[10.5px]">Opening message</div>
              <textarea
                value={draft.greeting ?? ''}
                onChange={(e) => set({ greeting: e.target.value })}
                rows={2}
                placeholder="Optional — opens each new conversation in character."
                className="input resize-none text-[13px] leading-[1.55]"
              />
            </div>

            <div className="border-t border-sibyl-border/60 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow text-[10.5px]">Sampling</span>
                <button
                  role="switch"
                  aria-checked={samplingOn}
                  onClick={() => setSamplingOn((v) => !v)}
                  className={`relative h-[18px] w-[34px] shrink-0 rounded-full transition-colors ${
                    samplingOn ? 'bg-sibyl-accent/40' : 'bg-sibyl-surface-2'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                      samplingOn ? 'left-[17px] bg-sibyl-accent' : 'left-0.5 bg-sibyl-muted'
                    }`}
                  />
                </button>
              </div>
              <div className="flex flex-col gap-3">
                <Slider
                  label="Temperature"
                  value={draft.generation?.temperature ?? CREATIVE.temperature}
                  min={0}
                  max={2}
                  step={0.05}
                  disabled={!samplingOn}
                  onChange={(v) => setGen({ temperature: v })}
                  format={(v) => v.toFixed(2)}
                />
                <Slider
                  label="Top-P"
                  value={draft.generation?.topP ?? CREATIVE.topP}
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={!samplingOn}
                  onChange={(v) => setGen({ topP: v })}
                  format={(v) => v.toFixed(2)}
                />
              </div>
            </div>
            {isSaved && showDelete && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] p-3 text-[12px]">
                <p className="mb-2 text-sibyl-secondary">
                  Used by {impact?.conversations ?? 0} conversation(s), including {impact?.scenes ?? 0} scene(s).
                  Frozen snapshots keep old work usable.
                </p>
                <select
                  value={replacementId}
                  onChange={(e) => setReplacementId(e.target.value)}
                  className="input mb-2 h-8 py-0 text-[12px]"
                >
                  <option value="">Replacement character…</option>
                  {personas.filter((persona) => persona.id !== draft.id).map((persona) => (
                    <option key={persona.id} value={persona.id}>{persona.name}</option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => { actions.deletePersona(draft.id, 'keep-snapshot'); onClose() }} className="btn-surface px-2 py-1">
                    Keep snapshots
                  </button>
                  <button onClick={() => { actions.deletePersona(draft.id, 'detach'); onClose() }} className="btn-surface px-2 py-1">
                    Detach
                  </button>
                  <button
                    disabled={!replacementId}
                    onClick={() => { actions.deletePersona(draft.id, 'replace', replacementId); onClose() }}
                    className="btn-surface px-2 py-1 disabled:opacity-40"
                  >
                    Replace
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-2 border-t border-sibyl-border/60 px-5 py-3.5">
          {isSaved ? (
            <button
              onClick={() => setShowDelete((value) => !value)}
              className="btn-ghost px-2.5 py-1.5 text-[12.5px] hover:text-red-300"
            >
              <TrashIcon size={13} /> {showDelete ? 'Cancel delete' : 'Delete'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={close} className="btn-ghost px-3 py-1.5 text-[12.5px]">
              Cancel
            </button>
            {conversationId && (
              <button onClick={() => void commit(false)} disabled={!canSave || saving} className="btn-surface px-3 py-1.5 text-[12.5px]">
                Save only
              </button>
            )}
            <button onClick={() => void commit(true)} disabled={!canSave || saving} className="btn-primary px-4 py-1.5 text-[12.5px]">
              {saving ? 'Saving…' : conversationId ? 'Apply' : 'Save'}
            </button>
          </div>
        </div>
        </fieldset>
      </div>
    </div>
  )
}
