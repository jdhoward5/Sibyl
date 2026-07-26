import type { Persona } from '@shared/types'
import { Avatar } from './Avatar'
import { CheckIcon } from '../../lib/icons'

/** A selectable persona tile in the new-thread picker. */
export function PersonaCard({
  persona,
  selected,
  onClick
}: {
  persona: Persona
  selected: boolean
  onClick: () => void
}) {
  const tags = [...persona.voiceTags]
  if (persona.generation) tags.push(`temp ${persona.generation.temperature}`)
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col rounded-lg border bg-sibyl-surface p-4 text-left transition-colors ${
        selected
          ? 'border-sibyl-accent/60 ring-[3px] ring-sibyl-accent/10'
          : 'border-sibyl-border hover:border-sibyl-accent/40'
      }`}
    >
      {selected && (
        <span className="absolute right-3 top-3 text-sibyl-accent">
          <CheckIcon size={16} />
        </span>
      )}
      <div className="mb-3 flex items-center gap-3">
        <Avatar avatar={persona.avatar} size={40} glow={false} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-sibyl-text">{persona.name}</div>
          {persona.role && <div className="truncate text-[12px] text-sibyl-muted">{persona.role}</div>}
        </div>
      </div>
      {persona.brief && (
        <p className="mb-3 line-clamp-2 text-[12.5px] leading-[1.55] text-sibyl-secondary">{persona.brief}</p>
      )}
      {tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-sibyl-border px-2 py-0.5 font-mono text-[10px] text-sibyl-muted"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
