import { actions, useStore } from '../../store'
import { formatBytes, formatEta, formatSpeed } from '@shared/format'
import { DownloadIcon, XIcon } from '../../lib/icons'

export function DownloadsBar() {
  const downloads = useStore((s) => s.downloads)
  const active = Object.values(downloads).filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'verifying'
  )
  if (active.length === 0) return null

  return (
    <div className="shrink-0 border-t border-oracle-border/60 bg-oracle-surface/80 px-4 py-2 backdrop-blur">
      <div className="mx-auto flex max-w-4xl flex-col gap-2">
        {active.map((d) => {
          const verifying = d.status === 'verifying'
          const verifyPct = d.verifyFraction != null ? d.verifyFraction * 100 : null
          // While verifying, the download bar is full; drive it from hash progress
          // when we have it, otherwise show it complete with a "Verifying…" label.
          const pct = verifying
            ? (verifyPct ?? 100)
            : d.totalBytes > 0
              ? (d.receivedBytes / d.totalBytes) * 100
              : 0
          return (
            <div key={d.id} className="flex items-center gap-3 text-[12px]">
              <DownloadIcon size={15} className="shrink-0 text-oracle-accent" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-oracle-text">{d.filename}</span>
                  <span className="shrink-0 text-oracle-muted">
                    {verifying
                      ? verifyPct != null
                        ? `Verifying… ${Math.round(verifyPct)}%`
                        : 'Verifying…'
                      : d.status === 'queued'
                        ? 'Queued…'
                        : `${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)} · ${formatSpeed(d.speed)} · ${formatEta(d.etaSeconds)}`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-oracle-bg">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-oracle-accent to-oracle-accent-2 transition-all duration-300"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
              <button
                onClick={() => actions.cancelDownload(d.id)}
                className="btn-ghost h-7 w-7 shrink-0 p-0"
                title="Cancel download"
              >
                <XIcon size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
