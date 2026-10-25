import { actions, useStore } from '../../store'
import { descriptorTags, formatBytes, isNsfwModel, parseParamLabel, quantRank } from '@shared/format'
import { canonicalGgufFilename, groupGgufFiles, type GgufDownloadGroup } from '@shared/modelFiles'
import { XIcon, DownloadIcon, CheckIcon, HeartIcon, ExternalLinkIcon } from '../../lib/icons'
import { useDialogFocus } from '../../lib/useDialogFocus'
import { useModelFit } from '../../lib/useModelFit'
import { ModelFitHint } from '../models/ModelFitHint'
import { searchModelSize } from '@shared/hardwareFit'

function recommendationFor(quant: string | undefined): string | null {
  if (!quant) return null
  const q = quant.toUpperCase()
  if (q.includes('Q4_K_M')) return 'Balanced quality and download size'
  if (q === 'Q8_0' || q === 'F16' || q === 'BF16') return 'Highest quality, largest size'
  if (q.startsWith('IQ') || q.includes('Q2') || q.includes('Q3')) return 'Smallest, lower quality'
  return null
}

export function ModelDetailDrawer() {
  const close = (): void => actions.closeModelDetail()
  const detail = useStore((s) => s.discover.selected)
  const loading = useStore((s) => s.discover.detailLoading)
  const dialogRef = useDialogFocus<HTMLDivElement>(close, loading || Boolean(detail))
  const downloads = useStore((s) => s.downloads)
  const installed = useStore((s) => s.installedModels)
  const contextSize = useStore((s) => s.settings?.load.contextSize)

  if (!loading && !detail) return null

  const sortedFiles = detail
    ? groupGgufFiles(detail.ggufFiles).sort((a, b) => quantRank(b.quant) - quantRank(a.quant))
    : []

  return (
    <div className="no-drag fixed bottom-0 left-0 right-0 top-10 z-40 flex justify-end">
      <div aria-hidden className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={detail ? 'model-detail-title' : undefined}
        aria-label={detail ? undefined : 'Loading model details'}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-xl animate-fade-in flex-col border-l border-sibyl-border bg-sibyl-surface shadow-2xl"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="h-3 w-3 animate-pulse-glow rounded-full bg-sibyl-accent" />
          </div>
        ) : detail ? (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-sibyl-border/60 p-5">
              <div className="min-w-0">
                <h2 id="model-detail-title" className="truncate text-lg font-semibold text-sibyl-text" title={detail.id}>
                  {detail.id.split('/').pop()}
                </h2>
                <p className="truncate text-[13px] text-sibyl-muted">{detail.id.split('/')[0]}</p>
                <div className="mt-2 flex items-center gap-4 text-[12px] text-sibyl-muted">
                  <span className="flex items-center gap-1">
                    <DownloadIcon size={13} /> {detail.downloads.toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <HeartIcon size={13} /> {detail.likes.toLocaleString()}
                  </span>
                  <a
                    href={`https://huggingface.co/${detail.id}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-sibyl-accent/90 hover:text-sibyl-accent"
                  >
                    <ExternalLinkIcon size={13} /> Hugging Face
                  </a>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {isNsfwModel(detail.tags) && (
                    <span className="chip border border-rose-500/40 text-rose-300/90">18+</span>
                  )}
                  {detail.gated && (
                    <span className="chip border border-amber-500/30 text-amber-300/90">gated</span>
                  )}
                  {parseParamLabel(detail.id.split('/').pop() ?? '') && (
                    <span className="chip">{parseParamLabel(detail.id.split('/').pop() ?? '')}</span>
                  )}
                  {detail.pipelineTag && <span className="chip">{detail.pipelineTag}</span>}
                  {descriptorTags(detail.tags).map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <button
                data-dialog-initial-focus
                onClick={close}
                className="btn-ghost h-8 w-8 p-0"
                aria-label="Close model details"
              >
                <XIcon size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-sibyl-muted">
                Quantizations ({sortedFiles.length})
              </h3>
              <p className="mb-4 text-[12px] leading-relaxed text-sibyl-secondary">
                Fit estimates use each complete file’s size at {contextSize?.toLocaleString()} tokens of context,
                with room reserved for the OS. Lower quantization or shorter context can help a model fit.
              </p>
              {sortedFiles.length === 0 && (
                <p className="text-[13px] text-sibyl-muted">
                  No GGUF quantizations found in this repo.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {sortedFiles.map((f) => (
                  <FileRow key={f.rfilename} file={f} repoId={detail.id} downloads={downloads} installed={installed} />
                ))}
              </div>

              {detail.description && (
                <>
                  <h3 className="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wide text-sibyl-muted">
                    About
                  </h3>
                  <p className="selectable whitespace-pre-wrap text-[13px] leading-relaxed text-sibyl-muted/90">
                    {detail.description.slice(0, 1500)}
                    {detail.description.length > 1500 ? '…' : ''}
                  </p>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function FileRow({
  file,
  repoId,
  downloads,
  installed
}: {
  file: GgufDownloadGroup
  repoId: string
  downloads: Record<string, { id: string; filename: string; status: string }>
  installed: { repoId: string; filename: string }[]
}) {
  const id = `${repoId}/${file.rfilename}`.replace(/[^a-zA-Z0-9._/-]/g, '_')
  const dl = downloads[id]
  const isInstalled = installed.some(
    (m) => m.repoId === repoId && canonicalGgufFilename(m.filename) === file.rfilename
  )
  const busy = dl && (dl.status === 'downloading' || dl.status === 'queued' || dl.status === 'verifying')
  const rec = recommendationFor(file.quant)
  const { fitFor, parameters } = useModelFit()
  const fit = fitFor({ sizeBytes: file.size ?? 0, paramLabel: (searchModelSize(file.rfilename) ?? searchModelSize(repoId.split('/').pop() ?? ''))?.paramLabel })
  const suggested = file.complete && file.quant?.toUpperCase() === 'Q4_K_M' && fit?.severity === 'comfortable'

  return (
    <div className={`card p-3 ${suggested ? 'border-emerald-300/30' : ''}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-sibyl-text">{file.quant ?? 'GGUF'}</span>
            {file.multipart && <span className="chip">{file.shardCount} parts</span>}
          </div>
          <div className="truncate text-[11px] text-sibyl-muted" title={file.rfilename}>
            {file.rfilename}
          </div>
          {rec && <div className="mt-0.5 text-[11px] text-sibyl-secondary">{rec}</div>}
        </div>
        <span className="shrink-0 text-[12px] text-sibyl-muted">{file.size ? formatBytes(file.size) : ''}</span>
        {isInstalled ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-emerald-300">
            <CheckIcon size={15} /> Installed
          </span>
        ) : busy ? (
          <span className="shrink-0 text-[12px] text-sibyl-accent">Downloading…</span>
        ) : !file.complete ? (
          <span className="shrink-0 text-[12px] text-sibyl-muted">Missing parts</span>
        ) : (
          <button
            onClick={() => actions.startDownload(repoId, file.rfilename)}
            className="btn-primary h-8 shrink-0"
          >
            <DownloadIcon size={14} /> Get
          </button>
        )}
      </div>
      {suggested && <div className="mt-2 text-[11px] font-medium text-emerald-200">Suggested for your hardware</div>}
      {file.size ? (
        <ModelFitHint fit={fit} unified={parameters?.resources.unifiedMemory} />
      ) : <p className="mt-2 text-[11px] text-sibyl-secondary">Fit unknown · {file.complete ? 'File size unavailable' : 'Incomplete shard set'}</p>}
      {fit && file.size ? (
        <details className="mt-2 text-[11px] text-sibyl-secondary">
          <summary className="w-fit cursor-pointer text-sibyl-text">Memory estimate details</summary>
          <ul className="mt-2 space-y-1 pl-4 list-disc">
            {fit.details.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
