import { useState } from 'react'
import { useStore } from '../../store'
import { EditIcon, PlusIcon, TrashIcon, UsersIcon } from '../../lib/icons'
import { Avatar } from './Avatar'
import { PersonaEditor } from './PersonaEditor'

export function CharactersView() {
  const characters = useStore((state) => state.settings?.personas ?? [])
  const [editor, setEditor] = useState<{ id: string | null } | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-sibyl-border/60 px-8 py-5">
        <div className="mx-auto flex max-w-[920px] items-end justify-between gap-6">
          <div>
            <div className="eyebrow mb-2 text-sibyl-accent">Characters</div>
            <h1 className="display-title text-[28px]">Character library</h1>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-sibyl-muted">
              Shape the voices that inhabit your conversations and ensemble scenes.
            </p>
          </div>
          <button onClick={() => setEditor({ id: null })} className="btn-primary h-10 shrink-0">
            <PlusIcon size={15} /> Create character
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[920px] px-8 py-6">
          {characters.length === 0 ? (
            <div className="empty-stage">
              <UsersIcon size={34} className="text-sibyl-accent/70" />
              <h2 className="mt-4 text-[17px] font-semibold text-sibyl-text">The stage is waiting</h2>
              <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-sibyl-muted">
                Create a character with a distinct identity, voice, and way of speaking.
              </p>
              <button onClick={() => setEditor({ id: null })} className="btn-primary mt-5">
                <PlusIcon size={15} /> Create character
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {characters.map((character) => (
                <article key={character.id} className="card group flex min-h-[168px] flex-col p-5">
                  <div className="flex items-start gap-3">
                    <Avatar avatar={character.avatar} size={44} glow={false} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[15px] font-semibold text-sibyl-text">
                        {character.name}
                      </h2>
                      <p className="mt-0.5 truncate text-[12px] text-sibyl-accent">
                        {character.role || 'Character'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditor({ id: character.id })}
                        className="btn-ghost h-8 w-8 p-0"
                        title={`Edit ${character.name}`}
                      >
                        <EditIcon size={14} />
                      </button>
                      <button
                        onClick={() => setEditor({ id: character.id })}
                        className="btn-ghost h-8 w-8 p-0 hover:text-red-300"
                        title={`Review deletion of ${character.name}`}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </div>
                  {character.brief && (
                    <p className="mt-4 line-clamp-3 text-[12.5px] leading-relaxed text-sibyl-secondary">
                      {character.brief}
                    </p>
                  )}
                  {character.voiceTags.length > 0 && (
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
                      {character.voiceTags.map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {editor && (
        <PersonaEditor initialPersonaId={editor.id} onClose={() => setEditor(null)} />
      )}
    </div>
  )
}
