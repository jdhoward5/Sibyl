import type { ModelFitEstimate } from '@shared/hardwareFit'
import { formatBytes } from '@shared/format'

const labels = {
  comfortable: 'Likely fits',
  tight: 'Tight fit',
  infeasible: 'Over budget',
  unknown: 'Fit unknown'
}
const colors = {
  comfortable: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200',
  tight: 'border-amber-300/25 bg-amber-300/10 text-amber-200',
  infeasible: 'border-rose-300/25 bg-rose-300/10 text-rose-200',
  unknown: 'border-sibyl-border bg-sibyl-surface-2 text-sibyl-secondary'
}

export function ModelFitHint({ fit, preview = false, unified = false }: {
  fit: ModelFitEstimate | null
  preview?: boolean
  unified?: boolean
}) {
  const severity = fit?.severity ?? 'unknown'
  return (
    <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" title={fit?.details.join('\n')}>
      <span className={`rounded border px-2 py-0.5 font-medium ${colors[severity]}`}>
        {labels[severity]}
      </span>
      <span className="text-sibyl-secondary">
        {preview && 'Q4 preview · '}
        {fit
          ? `~${formatBytes(fit.estimatedRamBytes)} ${unified ? 'shared memory' : 'RAM'}${
              fit.offloadFraction > 0 && !unified ? ` + ${formatBytes(fit.estimatedVramBytes)} VRAM` : ''}`
          : 'Check hardware information above'}
      </span>
    </span>
  )
}
