import { useStore } from '../store'
import { SparkIcon } from '../lib/icons'
import { EngineBadge } from './common/EngineBadge'

export function TitleBar() {
  const appInfo = useStore((s) => s.appInfo)
  // Window caption buttons differ by platform: macOS draws its traffic lights at
  // the top-left, Windows draws ours on the right (via titleBarOverlay). Pad the
  // header to clear whichever side owns the buttons so our content never sits
  // under them.
  const isMac = appInfo?.platform === 'darwin'
  return (
    <header
      className={`drag-region flex h-10 shrink-0 items-center justify-between border-b border-sibyl-border/60 bg-sibyl-bg ${
        isMac ? 'pl-[82px] pr-4' : 'pl-3 pr-[140px]'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-sibyl-accent to-sibyl-accent-2 text-white shadow-md shadow-sibyl-accent/30">
          <SparkIcon size={15} />
        </div>
        <span className="text-[13px] font-semibold tracking-wide text-sibyl-text">Sibyl</span>
        {appInfo && (
          <span className="text-[11px] text-sibyl-muted/70">v{appInfo.version}</span>
        )}
      </div>
      <EngineBadge />
    </header>
  )
}
