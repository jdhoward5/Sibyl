import type { HFModelSummary } from '@shared/types'
import { descriptorTags, isNsfwModel, parseParamLabel } from '@shared/format'
import { DownloadIcon } from '../../lib/icons'
import { searchModelSize } from '@shared/hardwareFit'
import { useModelFit } from '../../lib/useModelFit'
import { ModelFitHint } from '../models/ModelFitHint'

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function ModelCard({ model, onClick }: { model: HFModelSummary; onClick: () => void }) {
  const [author, name] = model.id.includes('/') ? model.id.split(/\/(.*)/s) : ['', model.id]
  const nsfw = isNsfwModel(model.tags)
  const param = parseParamLabel(name)
  const { fitFor, parameters } = useModelFit()
  const size = searchModelSize(name)
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-4 rounded-lg border border-sibyl-border bg-sibyl-surface p-4 text-left transition-colors duration-150 hover:border-sibyl-accent/45"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[14.5px] font-bold text-sibyl-text" title={model.id}>
            {name}
          </span>
          {param && (
            <span className="shrink-0 rounded-full border border-sibyl-accent/30 bg-sibyl-accent/10 px-2 py-px font-mono text-[10px] text-sibyl-accent">
              {param}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-[12.5px] text-sibyl-muted">{author}</div>
        {size ? <ModelFitHint fit={fitFor(size)} preview unified={parameters?.resources.unifiedMemory} />
          : <span className="mt-2 block text-[11px] text-sibyl-secondary">Fit unknown · Open to compare file sizes</span>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {nsfw && (
            <span className="rounded border border-rose-500/40 px-2 py-0.5 font-mono text-[11px] text-rose-300/90">18+</span>
          )}
          {model.gated && (
            <span className="rounded border border-amber-500/30 px-2 py-0.5 font-mono text-[11px] text-amber-300/90">gated</span>
          )}
          {descriptorTags(model.tags).map((t) => (
            <span key={t} className="rounded bg-sibyl-surface-2 px-2 py-0.5 font-mono text-[11px] text-sibyl-secondary">
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2.5">
        <div className="font-mono text-[11px] text-sibyl-muted">
          ↓ {compact(model.downloads)} · ♥ {compact(model.likes)}
        </div>
        <span className="btn-primary pointer-events-none h-9 px-4 text-[12.5px]">
          <DownloadIcon size={14} /> View
        </span>
      </div>
    </button>
  )
}
