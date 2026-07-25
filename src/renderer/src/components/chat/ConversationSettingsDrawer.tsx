import { useState } from 'react'
import type { Conversation, GenerationOptions, RoleplayFact } from '@shared/types'
import { actions, uid, useStore } from '../../store'
import { Slider, Toggle } from '../common/controls'
import { XIcon, DownloadIcon } from '../../lib/icons'
import { isScene } from '@shared/scene'
import { DEFAULT_SCENE_DIRECTOR } from '@shared/sceneDirector'
import { useDialogFocus } from '../../lib/useDialogFocus'
import { PortableExportDialog } from '../PortableDataDialogs'

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
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose)
  const settings = useStore((s) => s.settings)
  const installedVoices = useStore((s) => s.installedVoices)
  const scene = isScene(conversation)
  const [systemPrompt, setSystemPrompt] = useState(conversation.overrides?.systemPrompt ?? '')
  const [ucName, setUcName] = useState(conversation.userCharacter?.name ?? '')
  const [ucDesc, setUcDesc] = useState(conversation.userCharacter?.description ?? '')
  const [genOn, setGenOn] = useState(Boolean(conversation.overrides?.generation))
  const [factText, setFactText] = useState('')
  const [director, setDirector] = useState(
    conversation.director ?? DEFAULT_SCENE_DIRECTOR
  )
  const [sceneVoice, setSceneVoice] = useState(conversation.sceneVoice ?? {})
  const [portableExportOpen, setPortableExportOpen] = useState(false)
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
    void actions.setUserCharacter(
      conversation.id,
      ucName.trim() || ucDesc.trim() ? { name: ucName.trim(), description: ucDesc.trim() } : undefined
    )
    if (scene) void actions.setSceneDirector(conversation.id, director)
    if (scene) void actions.setSceneVoice(conversation.id, sceneVoice)
    onClose()
  }

  const clearAll = (): void => {
    void actions.setConversationOverrides(conversation.id, undefined)
    void actions.setUserCharacter(conversation.id, undefined)
    if (scene) {
      void actions.setSceneDirector(conversation.id, DEFAULT_SCENE_DIRECTOR)
      void actions.setSceneVoice(conversation.id, undefined)
    }
    onClose()
  }

  const setG = (patch: Partial<GenerationOptions>): void => setGen((g) => ({ ...g, ...patch }))

  return (
    <div className="no-drag fixed bottom-0 left-0 right-0 top-10 z-40 flex justify-end">
      <div aria-hidden className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-settings-title"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md animate-fade-in flex-col border-l border-sibyl-border bg-sibyl-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-sibyl-border/60 p-5">
          <div className="min-w-0">
            <h2 id="thread-settings-title" className="text-lg font-semibold text-sibyl-text">Thread settings</h2>
            <p className="truncate text-[12.5px] text-sibyl-muted" title={conversation.title}>
              {conversation.title}
            </p>
          </div>
          <button
            data-dialog-initial-focus
            onClick={onClose}
            className="btn-ghost h-8 w-8 p-0"
            aria-label="Close thread settings"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-col gap-5">
            {/* System prompt override */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="conversation-system-prompt" className="text-[13px] font-medium text-sibyl-text">
                  {scene ? 'Scene instruction' : 'Character brief override'}
                </label>
                {!scene && settings.personas.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const p = settings.personas.find((x) => x.id === e.target.value)
                      if (p) setSystemPrompt(p.brief)
                    }}
                    className="input h-7 w-auto px-2 py-0 text-[12px]"
                  >
                    <option value="">Copy from persona…</option>
                    {settings.personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <textarea
                id="conversation-system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                placeholder={
                  scene
                    ? 'Optional direction applied to every character and every beat in this scene.'
                    : conversation.personaId
                    ? 'Leave empty to use this thread’s persona brief.'
                    : `Leave empty to use the global character brief:\n${settings.load.systemPrompt}`
                }
                className="input resize-none text-[13px]"
              />
            {scene && (
                <p className="mt-1.5 text-[12px] text-sibyl-muted">
                  Shared by the whole cast. Each character’s own brief still defines their role.
                </p>
            )}

            {scene && (
              <div className="rounded-lg border border-sibyl-border/60 p-3.5">
                <label htmlFor="scene-knowledge-mode" className="mb-1.5 block text-[13px] font-medium text-sibyl-text">
                  Character knowledge
                </label>
                <select
                  id="scene-knowledge-mode"
                  value={conversation.knowledgeMode ?? 'scoped'}
                  onChange={(e) =>
                    void actions.setKnowledgeMode(
                      conversation.id,
                      e.target.value as Conversation['knowledgeMode']
                    )
                  }
                  className="input h-8 py-0 text-[12px]"
                >
                  <option value="scoped">Scoped · respect private knowledge</option>
                  <option value="public-only">Compatibility · treat all as public</option>
                </select>
                <p className="mt-1.5 text-[11.5px] text-sibyl-muted">
                  You always see all material. Scoped mode filters private segments before a character prompt is built.
                </p>
              </div>
            )}

            {scene && (
              <div className="rounded-lg border border-sibyl-border/60 p-3.5">
                <label
                  htmlFor="scene-default-voice"
                  className="mb-1.5 block text-[13px] font-medium text-sibyl-text"
                >
                  Scene voice fallback
                </label>
                <p className="mb-2 text-[11.5px] text-sibyl-muted">
                  Character voice overrides win. This voice is used next, then the global default.
                </p>
                <div className="flex gap-2">
                  <select
                    id="scene-default-voice"
                    value={sceneVoice.voiceId ?? ''}
                    onChange={(event) =>
                      setSceneVoice((value) => ({
                        ...value,
                        voiceId: event.target.value || undefined
                      }))
                    }
                    className="input h-8 flex-1 py-0 text-[12px]"
                  >
                    <option value="">Use global default</option>
                    {installedVoices
                      .filter(
                        (voice) =>
                          !voice.availability || voice.availability === 'available'
                      )
                      .map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name}
                        </option>
                      ))}
                  </select>
                  <label className="sr-only" htmlFor="scene-default-rate">
                    Scene speaking rate
                  </label>
                  <input
                    id="scene-default-rate"
                    type="number"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={sceneVoice.rate ?? ''}
                    onChange={(event) =>
                      setSceneVoice((value) => ({
                        ...value,
                        rate: event.target.value ? Number(event.target.value) : undefined
                      }))
                    }
                    className="input w-24 text-[12px]"
                    placeholder={`${settings.tts.rate.toFixed(2)}×`}
                  />
                </div>
              </div>
            )}

            {scene && (
              <div className="rounded-lg border border-sibyl-border/60 p-3.5">
                <Toggle
                  label="Local scene director"
                  desc="Optionally spends a small local inference pass to choose the next speaker or pause/end naturally."
                  checked={director.enabled}
                  onChange={(enabled) => setDirector((value) => ({ ...value, enabled }))}
                />
                {director.enabled && (
                  <div className="mt-3 space-y-2">
                    <Toggle
                      label="Use loaded model"
                      desc="Off uses deterministic round-robin and targeted-direction rules only."
                      checked={director.useModel}
                      onChange={(useModel) => setDirector((value) => ({ ...value, useModel }))}
                    />
                    <input
                      value={director.sceneGoal ?? ''}
                      onChange={(e) =>
                        setDirector((value) => ({ ...value, sceneGoal: e.target.value }))
                      }
                      className="input text-[12px]"
                      placeholder="Optional scene goal"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <select aria-label="Scene pacing" value={director.pacing} onChange={(e) => setDirector((value) => ({ ...value, pacing: e.target.value as typeof director.pacing }))} className="input h-8 py-0 text-[11px]">
                        <option value="slow">Slow pace</option><option value="balanced">Balanced pace</option><option value="fast">Fast pace</option>
                      </select>
                      <select aria-label="Character initiative" value={director.initiative} onChange={(e) => setDirector((value) => ({ ...value, initiative: e.target.value as typeof director.initiative }))} className="input h-8 py-0 text-[11px]">
                        <option value="low">Low initiative</option><option value="balanced">Balanced initiative</option><option value="high">High initiative</option>
                      </select>
                      <select aria-label="Human interruption policy" value={director.interruption} onChange={(e) => setDirector((value) => ({ ...value, interruption: e.target.value as typeof director.interruption }))} className="input h-8 py-0 text-[11px]">
                        <option value="never">Never interrupt</option><option value="natural-pauses">Natural pauses</option><option value="often">Invite often</option>
                      </select>
                    </div>
                    <Toggle
                      label="Inspect private intent"
                      desc="Shows the latest ephemeral planning sentence during a run; it is never saved or exported."
                      checked={director.inspectIntent}
                      onChange={(inspectIntent) =>
                        setDirector((value) => ({ ...value, inspectIntent }))
                      }
                    />
                  </div>
                )}
              </div>
            )}

            {(conversation.personaSnapshot || conversation.castSnapshots?.length) && (
              <div>
                <h3 className="mb-2 text-[13px] font-semibold text-sibyl-text">Frozen identity</h3>
                <div className="space-y-2">
                  {[
                    ...(conversation.personaSnapshot ? [conversation.personaSnapshot] : []),
                    ...(conversation.castSnapshots ?? [])
                  ].map((snapshot) => {
                    const current = settings.personas.find(
                      (persona) => persona.id === snapshot.sourcePersonaId
                    )
                    const changed = current && (current.version ?? 1) !== snapshot.sourceVersion
                    const override = conversation.personaOverrides?.find(
                      (item) => item.personaId === snapshot.sourcePersonaId
                    )
                    return (
                      <div key={snapshot.sourcePersonaId} className="rounded-lg border border-sibyl-border/50 px-2.5 py-2 text-[12px]">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {snapshot.persona.name} · revision {snapshot.sourceVersion}
                          </span>
                          {changed && (
                            <button
                              onClick={() =>
                                void actions.refreshConversationPersona(
                                  conversation.id,
                                  snapshot.sourcePersonaId
                                )
                              }
                              className="btn-surface px-2 py-1 text-[11px]"
                            >
                              Refresh
                            </button>
                          )}
                          {!current && <span className="text-[11px] text-sibyl-muted">Snapshot only</span>}
                        </div>
                        {scene && (
                          <>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <textarea
                              defaultValue={(override?.privateMotivations ?? []).join('\n')}
                              onBlur={(e) =>
                                void actions.setScenePersonaOverride(
                                  conversation.id,
                                  snapshot.sourcePersonaId,
                                  {
                                    ...override,
                                    privateMotivations: e.target.value
                                      .split('\n')
                                      .map((value) => value.trim())
                                      .filter(Boolean)
                                  }
                                )
                              }
                              rows={2}
                              className="input resize-none text-[11.5px]"
                              placeholder="Scene-local private goals"
                            />
                            <textarea
                              defaultValue={override?.speechGuidance ?? ''}
                              onBlur={(e) =>
                                void actions.setScenePersonaOverride(
                                  conversation.id,
                                  snapshot.sourcePersonaId,
                                  {
                                    ...override,
                                    speechGuidance: e.target.value.trim() || undefined
                                  }
                                )
                              }
                              rows={2}
                              className="input resize-none text-[11.5px]"
                              placeholder="Scene-local speech guidance"
                            />
                          </div>
                          {override && current && (
                            <button
                              onClick={() =>
                                actions.promoteScenePersonaOverride(
                                  conversation.id,
                                  snapshot.sourcePersonaId
                                )
                              }
                              className="btn-ghost mt-1.5 px-1 py-0.5 text-[10.5px]"
                            >
                              Promote scene changes to library
                            </button>
                          )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {scene && (
              <div>
                <h3 className="mb-2 text-[13px] font-semibold text-sibyl-text">Active directions</h3>
                <div className="space-y-2">
                  {(conversation.directions ?? [])
                    .filter((direction) => !direction.consumedAt && !direction.resolvedAt)
                    .map((direction) => (
                      <div key={direction.id} className="rounded-lg border border-sibyl-border/50 p-2.5 text-[12px]">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="font-mono text-[10px] uppercase text-sibyl-accent-2">
                            {direction.scope} · {direction.target.kind === 'cast' ? 'whole cast' : direction.target.speakerId}
                          </span>
                          <span className="flex-1" />
                          <button
                            onClick={() =>
                              void actions.saveDirection(conversation.id, {
                                ...direction,
                                enabled: !direction.enabled
                              })
                            }
                            className="text-sibyl-muted hover:text-sibyl-text"
                          >
                            {direction.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => void actions.removeDirection(conversation.id, direction.id)}
                            className="text-sibyl-muted hover:text-red-300"
                          >
                            Remove
                          </button>
                        </div>
                        <textarea
                          aria-label={`Direction: ${direction.content}`}
                          defaultValue={direction.content}
                          onBlur={(e) => {
                            const content = e.target.value.trim()
                            if (content && content !== direction.content) {
                              void actions.saveDirection(conversation.id, { ...direction, content })
                            }
                          }}
                          rows={2}
                          className="input resize-none text-[12px]"
                        />
                        <div className="mt-2 flex gap-2">
                          <select
                            aria-label="Direction lifetime"
                            value={direction.scope}
                            onChange={(e) =>
                              void actions.saveDirection(conversation.id, {
                                ...direction,
                                scope: e.target.value as typeof direction.scope
                              })
                            }
                            className="input h-7 flex-1 py-0 text-[11px]"
                          >
                            <option value="next-beat">Next beat</option>
                            <option value="until-resolved">Until resolved</option>
                            <option value="persistent">Persistent</option>
                            <option value="scene-metadata">Scene metadata</option>
                          </select>
                          <select
                            aria-label="Direction target"
                            value={
                              direction.target.kind === 'cast'
                                ? 'cast'
                                : direction.target.speakerId
                            }
                            onChange={(e) =>
                              void actions.saveDirection(conversation.id, {
                                ...direction,
                                target:
                                  e.target.value === 'cast'
                                    ? { kind: 'cast' }
                                    : { kind: 'speaker', speakerId: e.target.value }
                              })
                            }
                            className="input h-7 flex-1 py-0 text-[11px]"
                          >
                            <option value="cast">Whole cast</option>
                            {(conversation.castSnapshots ?? []).map((snapshot) => (
                              <option key={snapshot.sourcePersonaId} value={snapshot.sourcePersonaId}>
                                {snapshot.persona.name}
                              </option>
                            ))}
                          </select>
                          {direction.scope === 'until-resolved' && (
                            <button
                              onClick={() =>
                                void actions.saveDirection(conversation.id, {
                                  ...direction,
                                  resolvedAt: new Date().toISOString()
                                })
                              }
                              className="btn-ghost px-2 py-1 text-[11px]"
                            >
                              Resolve
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  {!(conversation.directions ?? []).some(
                    (direction) => !direction.consumedAt && !direction.resolvedAt
                  ) && <p className="text-[12px] text-sibyl-muted">No active directions.</p>}
                </div>
              </div>
            )}

            {scene && conversation.roleplayState && (
              <div>
                <h3 className="mb-1 text-[13px] font-semibold text-sibyl-text">Continuity memory</h3>
                <p className="mb-2 text-[11.5px] text-sibyl-muted">
                  Facts retain source message IDs. Pinned corrections cannot be replaced by automatic maintenance.
                </p>
                <div className="space-y-2">
                  {conversation.roleplayState.facts.map((fact) => (
                    <div key={fact.id} className="flex items-start gap-2 rounded-lg border border-sibyl-border/50 p-2 text-[12px]">
                      <button
                        title={fact.pinned ? 'Unpin fact' : 'Pin fact'}
                        onClick={() =>
                          void actions.upsertRoleplayFact(conversation.id, {
                            ...fact,
                            pinned: !fact.pinned,
                            userAuthored: true,
                            updatedAt: new Date().toISOString()
                          })
                        }
                        className={fact.pinned ? 'text-sibyl-accent' : 'text-sibyl-muted'}
                      >
                        {fact.pinned ? '●' : '○'}
                      </button>
                      <textarea
                        defaultValue={fact.text}
                        onBlur={(e) => {
                          const text = e.target.value.trim()
                          if (text && text !== fact.text) {
                            void actions.upsertRoleplayFact(conversation.id, {
                              ...fact,
                              text,
                              userAuthored: true,
                              updatedAt: new Date().toISOString()
                            })
                          }
                        }}
                        rows={2}
                        className="input flex-1 resize-none text-[12px]"
                        aria-label={`Edit ${fact.category} fact`}
                      />
                      <button
                        onClick={() => void actions.removeRoleplayFact(conversation.id, fact.id)}
                        className="text-sibyl-muted hover:text-red-300"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={factText}
                    onChange={(e) => setFactText(e.target.value)}
                    className="input flex-1 text-[12px]"
                    placeholder="Add a pinned continuity fact"
                  />
                  <button
                    disabled={!factText.trim()}
                    onClick={() => {
                      const fact: RoleplayFact = {
                        id: uid(),
                        category: 'other',
                        text: factText.trim(),
                        visibility: { kind: 'public' },
                        provenanceMessageIds: [],
                        userAuthored: true,
                        pinned: true,
                        updatedAt: new Date().toISOString()
                      }
                      void actions.upsertRoleplayFact(conversation.id, fact)
                      setFactText('')
                    }}
                    className="btn-surface px-2.5 py-1.5 text-[12px] disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
            </div>

            {/* Your character (user persona) */}
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-sibyl-text">Your character</label>
              <p className="mb-2 text-[12px] text-sibyl-muted">
                Optional — who you play. Injected as “The user plays …”.
              </p>
              <input
                value={ucName}
                onChange={(e) => setUcName(e.target.value)}
                placeholder="Name (e.g. a wandering courier)"
                className="input mb-2 text-[13px]"
              />
              <textarea
                value={ucDesc}
                onChange={(e) => setUcDesc(e.target.value)}
                rows={2}
                placeholder="A short description of your character (optional)."
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
              <button
                type="button"
                onClick={() => setPortableExportOpen(true)}
                className="btn-primary mb-2 w-full justify-center px-2.5 py-2 text-[12px]"
              >
                <DownloadIcon size={13} /> Encrypted .sibyl bundle
              </button>
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
              <p className="mt-2 text-[11.5px] leading-relaxed text-amber-300">
                Markdown, JSON, and Text are intentional plaintext escape hatches.
                They expose the conversation and its metadata anywhere you save them.
              </p>
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
      {portableExportOpen && (
        <PortableExportDialog
          conversationId={conversation.id}
          onClose={() => setPortableExportOpen(false)}
        />
      )}
    </div>
  )
}
