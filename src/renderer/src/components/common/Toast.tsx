import { actions, useStore } from '../../store'
import { CheckIcon, XIcon, BoltIcon } from '../../lib/icons'

export function Toast() {
  const toast = useStore((s) => s.toast)
  if (!toast) return null

  const tone =
    toast.kind === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-200'
      : toast.kind === 'success'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
        : 'border-sibyl-border bg-sibyl-surface-2 text-sibyl-text'

  const Icon = toast.kind === 'success' ? CheckIcon : toast.kind === 'error' ? XIcon : BoltIcon

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-fade-in">
      <div
        role={toast.kind === 'error' ? 'alert' : 'status'}
        aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        className={`pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur ${tone}`}
      >
        <Icon size={16} />
        <span className="flex-1">{toast.message}</span>
        <button
          onClick={() => actions.dismissToast()}
          className="opacity-60 hover:opacity-100"
          aria-label="Dismiss notification"
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  )
}
