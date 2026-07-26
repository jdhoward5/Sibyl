import { actions, useStore, type View } from '../store'
import { ChatIcon, UsersIcon, BoxIcon, SettingsIcon } from '../lib/icons'

const items: { view: View; label: string; Icon: typeof ChatIcon }[] = [
  { view: 'studio', label: 'Studio', Icon: ChatIcon },
  { view: 'characters', label: 'Characters', Icon: UsersIcon },
  { view: 'models', label: 'Models', Icon: BoxIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon }
]

export function Rail() {
  const view = useStore((s) => s.view)
  const modelCount = useStore((s) => s.installedModels.length)
  const downloadCount = useStore(
    (s) => Object.values(s.downloads).filter((d) => d.status === 'downloading' || d.status === 'queued').length
  )

  return (
    <nav
      aria-label="Primary"
      className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-sibyl-border/60 bg-sibyl-sunken py-3"
    >
      {items.map(({ view: v, label, Icon }) => {
        const active = view === v
        const badge = v === 'models' && downloadCount > 0 ? downloadCount : 0
        return (
          <button
            key={v}
            onClick={() => actions.setView(v)}
            aria-current={active ? 'page' : undefined}
            className={`no-drag group relative flex h-14 w-[66px] flex-col items-center justify-center gap-1 rounded-lg transition-colors duration-150 ${
              active
                ? 'bg-sibyl-surface-2 text-sibyl-text'
                : 'text-sibyl-muted hover:bg-sibyl-surface hover:text-sibyl-text'
            }`}
            title={label}
          >
            {active && (
              <span
                className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r bg-sibyl-accent"
              />
            )}
            <Icon size={20} />
            <span className="text-[9.5px] font-medium">{label}</span>
            {badge > 0 && (
              <span className="absolute right-2 top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-sibyl-accent px-1 text-[9px] font-bold text-white">
                {badge}
              </span>
            )}
            {v === 'models' && badge === 0 && modelCount > 0 && (
              <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-sibyl-accent/60" />
            )}
          </button>
        )
      })}
    </nav>
  )
}
