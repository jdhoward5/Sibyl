import { useState } from 'react'
import { actions, useStore } from '../../store'
import { PersonaCard } from './PersonaCard'
import { PersonaEditor } from './PersonaEditor'
import { PlusIcon, ChevronRight, ChatIcon, UsersIcon } from '../../lib/icons'

type Mode = 'thread' | 'scene'

/**
 * The new-conversation picker shown over the chat column. Two modes:
 *  - Thread: pick one saved persona (or blank) to write a solo conversation.
 *  - Scene: pick a cast of ≥2 personas who roleplay with each other while you
 *    watch, join in, or direct.
 */
export function PersonaPicker({ canCancel }: { canCancel: boolean }) {
  const personas = useStore((s) => s.settings?.personas ?? [])
  const [mode, setMode] = useState<Mode>('thread')
  // Thread: `undefined` = nothing chosen, `null` = explicitly blank.
  const [selected, setSelected] = useState<string | null | undefined>(personas[0]?.id)
  // Scene: the chosen cast (persona ids), premise and the human's own character.
  const [cast, setCast] = useState<string[]>([])
  const [premise, setPremise] = useState('')
  const [playName, setPlayName] = useState('')
  const [playDesc, setPlayDesc] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)

  const chosen = personas.find((p) => p.id === selected) ?? null

  const startThread = (personaId: string | null): void => {
    actions.newConversation(personaId ?? undefined)
    actions.closePersonaPicker()
  }
  const startScene = (): void => {
    if (cast.length < 2) return
    actions.newScene(cast, {
      premise: premise.trim() || undefined,
      userCharacter:
        playName.trim() || playDesc.trim() ? { name: playName.trim(), description: playDesc.trim() } : undefined
    })
    actions.closePersonaPicker()
  }
  const toggleCast = (id: string): void =>
    setCast((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))

  const Tab = ({ value, icon, label }: { value: Mode; icon: React.ReactNode; label: string }) => (
    <button
      onClick={() => setMode(value)}
      className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors ${
        mode === value ? 'bg-sibyl-accent/15 text-sibyl-accent' : 'text-sibyl-muted hover:text-sibyl-text'
      }`}
    >
      {icon} {label}
    </button>
  )

  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{
        background:
          'radial-gradient(900px 380px at 50% -8%, rgb(var(--sibyl-accent) / 0.06), transparent 70%)'
      }}
    >
      <div className="mx-auto max-w-[760px] px-8 pb-12 pt-14">
        <div className="eyebrow mb-2.5 text-sibyl-accent">New conversation</div>
        <h2 className="display-title mb-4 text-[30px]">
          {mode === 'scene' ? 'Cast an ensemble scene' : 'Who enters the studio?'}
        </h2>

        <div className="mb-6 inline-flex items-center gap-1 rounded-xl border border-sibyl-border bg-sibyl-surface p-1">
          <Tab value="thread" icon={<ChatIcon size={15} />} label="One character" />
          <Tab value="scene" icon={<UsersIcon size={15} />} label="Ensemble scene" />
        </div>

        <p className="mb-7 text-[14.5px] leading-relaxed text-sibyl-muted">
          {mode === 'scene'
            ? 'Pick two or more characters. They’ll converse with each other — watch it play out, jump in as your own character, or step in to direct.'
            : 'Choose a character and begin a private conversation, or open a blank page.'}
        </p>

        {mode === 'scene' && (
          <div className="mb-5 grid grid-cols-1 gap-3">
            <div>
              <label className="eyebrow mb-1.5 block text-sibyl-muted">Premise (optional)</label>
              <textarea
                value={premise}
                onChange={(e) => setPremise(e.target.value)}
                rows={2}
                placeholder="Where and when does this scene take place? What’s the situation?"
                className="input w-full resize-none text-[13.5px]"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr]">
              <div>
                <label className="eyebrow mb-1.5 block text-sibyl-muted">You play (optional)</label>
                <input
                  value={playName}
                  onChange={(e) => setPlayName(e.target.value)}
                  placeholder="Your character"
                  className="input w-full text-[13.5px]"
                />
              </div>
              <div>
                <label className="eyebrow mb-1.5 block text-sibyl-muted">&nbsp;</label>
                <input
                  value={playDesc}
                  onChange={(e) => setPlayDesc(e.target.value)}
                  placeholder="A short description of who you are in the scene"
                  className="input w-full text-[13.5px]"
                />
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {personas.map((p) =>
            mode === 'scene' ? (
              <PersonaCard key={p.id} persona={p} selected={cast.includes(p.id)} onClick={() => toggleCast(p.id)} />
            ) : (
              <PersonaCard key={p.id} persona={p} selected={selected === p.id} onClick={() => setSelected(p.id)} />
            )
          )}

          {/* Blank thread (solo only) */}
          {mode === 'thread' && (
            <button
              onClick={() => setSelected(null)}
              className={`flex items-center gap-3 rounded-lg border bg-sibyl-surface p-4 text-left transition-colors ${
                selected === null ? 'border-sibyl-accent/60 ring-[3px] ring-sibyl-accent/10' : 'border-sibyl-border hover:border-sibyl-accent/40'
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-sibyl-border text-sibyl-muted">
                <PlusIcon size={18} />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-sibyl-text">Blank conversation</div>
                <div className="text-[12px] text-sibyl-muted">No character · global brief</div>
              </div>
            </button>
          )}

          {/* New persona */}
          <button
            onClick={() => setEditorOpen(true)}
            className="flex items-center gap-3 rounded-lg border border-dashed border-sibyl-accent/40 bg-sibyl-accent/[0.04] p-4 text-left transition-colors hover:bg-sibyl-accent/10"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sibyl-accent/15 text-sibyl-accent">
              <PlusIcon size={18} />
            </div>
            <div>
              <div className="text-[14px] font-semibold text-sibyl-accent">New character</div>
              <div className="text-[12px] text-sibyl-muted">Shape one from scratch</div>
            </div>
          </button>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          {mode === 'scene' && (
            <span className="mr-auto text-[12.5px] text-sibyl-muted">
              {cast.length === 0
                ? 'Select at least two characters.'
                : cast.length === 1
                  ? 'Select one more character.'
                  : `${cast.length} characters cast.`}
            </span>
          )}
          {canCancel && (
            <button onClick={() => actions.closePersonaPicker()} className="btn-ghost px-4 py-2.5 text-[13px]">
              Cancel
            </button>
          )}
          {mode === 'scene' ? (
            <button
              onClick={startScene}
              disabled={cast.length < 2}
              className="btn-primary h-[42px] px-5 text-[14px] disabled:opacity-40"
            >
              Start scene{cast.length >= 2 ? ` · ${cast.length}` : ''}
              <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={() => startThread(selected === undefined ? null : selected)}
              className="btn-primary h-[42px] px-5 text-[14px]"
            >
              {chosen ? `Begin with ${chosen.name}` : 'Begin blank conversation'}
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {editorOpen && (
        <PersonaEditor
          onClose={() => setEditorOpen(false)}
          // Newly-saved persona becomes selectable; pre-select the freshest one after close.
        />
      )}
    </div>
  )
}
