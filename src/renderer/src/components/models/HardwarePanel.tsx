import { useEffect } from 'react'
import { formatBytes } from '@shared/format'
import { recommendedModelSize } from '@shared/hardwareFit'
import { actions, useStore } from '../../store'
import { useModelFit } from '../../lib/useModelFit'

export function HardwarePanel() {
  const hardware = useStore((s) => s.hardware)
  const loading = useStore((s) => s.hardwareLoading)
  const error = useStore((s) => s.hardwareError)
  const settings = useStore((s) => s.settings)
  const modelId = useStore((s) => s.engine.modelId)
  const { parameters } = useModelFit()
  const gpu = settings?.gpu
  useEffect(() => { void actions.refreshHardware() }, [gpu, modelId])
  const recommended = parameters ? recommendedModelSize(parameters) : null
  const gpuLabel = hardware?.gpuType === false ? 'CPU inference'
    : hardware?.gpuType ? hardware.gpuType.toUpperCase() : 'GPU not measured'
  const platform = hardware?.platform === 'darwin' ? 'macOS' : hardware?.platform === 'win32' ? 'Windows' : hardware?.platform

  return (
    <section aria-label="Hardware and model guidance" className="mb-5 rounded-xl border border-sibyl-accent/25 bg-sibyl-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[13px] font-semibold text-sibyl-text">Recommended for this machine</h2>
          <p className="mt-1 text-[13px] text-sibyl-accent">
            {recommended != null
              ? `Start with up to ${recommended}B parameters · Q4_K_M`
              : loading ? 'Checking your hardware…'
                : 'Choose a smaller Q4_K_M file and check its memory estimate'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-sibyl-secondary">
            At {settings?.load.contextSize.toLocaleString() ?? '—'} tokens of context · {!parameters ? 'detecting backend' : parameters.gpuEnabled
              ? settings?.load.gpuLayers === -1 ? 'auto GPU offload' : `${settings?.load.gpuLayers} GPU layers`
              : 'CPU inference'}.
            {' '}Memory estimates reserve room for the OS. Longer context needs more memory; speed varies by model.
          </p>
        </div>
        <button className="btn-ghost h-8 shrink-0 px-2 text-[11px]" disabled={loading}
          onClick={() => void actions.refreshHardware()} aria-label="Refresh hardware information">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {(error || hardware?.detectionError) && (
        <p role="status" className="mt-3 text-[12px] text-amber-200">{error || hardware?.detectionError}</p>
      )}
      {hardware && (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-3">
            <div><div className="text-[10px] uppercase tracking-wide text-sibyl-muted">Processor</div>
              <div className="mt-1 font-medium text-sibyl-text">{hardware.cpuModel}</div>
              <div className="text-[11px] text-sibyl-secondary">{hardware.logicalCores} logical cores</div></div>
            <div><div className="text-[10px] uppercase tracking-wide text-sibyl-muted">{hardware.unifiedMemory ? 'Unified memory' : 'System memory'}</div>
              <div className="mt-1 font-medium text-sibyl-text">{formatBytes(hardware.systemMemoryTotalBytes)} total</div>
              <div className="text-[11px] text-sibyl-secondary">{formatBytes(hardware.systemMemoryFreeBytes)} free now</div></div>
            <div><div className="text-[10px] uppercase tracking-wide text-sibyl-muted">Graphics · {gpuLabel}</div>
              <div className="mt-1 font-medium text-sibyl-text">{hardware.gpuNames.join(', ') || (hardware.gpuType === false ? 'Using the processor' : 'Device name unavailable')}</div>
              <div className="text-[11px] text-sibyl-secondary">{hardware.vramTotalBytes == null ? 'GPU capacity unavailable' : `${formatBytes(hardware.vramTotalBytes)} ${hardware.unifiedMemory ? 'shared GPU limit' : 'VRAM'}`}</div></div>
          </div>
          <details className="mt-4 border-t border-sibyl-border/60 pt-3 text-[11px] text-sibyl-secondary">
            <summary className="w-fit cursor-pointer text-sibyl-text">Hardware details & estimate assumptions</summary>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2">
              <dt>Operating system</dt><dd>{platform} · {hardware.arch} · kernel {hardware.osRelease}</dd>
              <dt>Selected backend</dt><dd>{settings?.gpu.toUpperCase()} · detected {gpuLabel}{modelId ? ' (current model)' : ''}</dd>
              <dt>GPU memory in use</dt><dd>{hardware.vramUsedBytes == null ? 'Not available' : formatBytes(hardware.vramUsedBytes)}</dd>
              <dt>Last checked</dt><dd>{new Date(hardware.detectedAt).toLocaleTimeString()}</dd>
            </dl>
            <p className="mt-3 leading-relaxed">{hardware.unifiedMemory
              ? 'CPU and GPU share the same memory. The GPU limit is part of system memory, not extra capacity. '
              : 'System RAM and GPU VRAM are separate budgets. '}
              Free RAM is an OS snapshot and can exclude reclaimable caches. Fit hints use total capacity with a reserve of 20% RAM (at least 4 GiB) and 10% GPU memory (at least 0.5 GiB), so an already loaded model does not skew recommendations.
            </p>
            <p className="mt-2 leading-relaxed">Search previews assume roughly 0.65 bytes per parameter for Q4 weights. File details use the full download size plus runtime and context overhead. Auto offload assumes all layers fit on the GPU; partial CPU offload may allow larger models at lower speed. These are estimates, not compatibility or speed guarantees.</p>
          </details>
        </>
      )}
    </section>
  )
}
