import { useStore } from '../../store'
import { formatBytes } from '@shared/format'
import { BoltIcon, CpuIcon } from '../../lib/icons'

export function EngineBadge() {
  const engine = useStore((s) => s.engine)
  const models = useStore((s) => s.installedModels)

  const loaded = models.find((m) => m.id === engine.modelId)
  const gpu = engine.gpuType
  const isGpu = gpu === 'cuda' || gpu === 'vulkan' || gpu === 'metal'

  if (engine.state === 'idle' && !engine.modelId) {
    return <span className="no-drag text-[11px] text-sibyl-muted">No model loaded</span>
  }

  return (
    <div className="no-drag flex items-center gap-3 text-[11px]">
      {engine.state === 'loading' && (
        <span className="flex items-center gap-1.5 text-sibyl-accent">
          <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-sibyl-accent" />
          Loading…
        </span>
      )}
      {loaded && (
        <span className="max-w-[260px] truncate font-medium text-sibyl-text" title={loaded.filename}>
          {loaded.filename.replace(/\.gguf$/i, '')}
        </span>
      )}
      <span
        className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 ${
          isGpu ? 'bg-sibyl-accent/15 text-sibyl-glow' : 'bg-sibyl-surface-2 text-sibyl-muted'
        }`}
        title={isGpu ? `GPU: ${String(gpu).toUpperCase()}` : 'CPU inference'}
      >
        {isGpu ? <BoltIcon size={12} /> : <CpuIcon size={12} />}
        {isGpu ? String(gpu).toUpperCase() : 'CPU'}
      </span>
      {engine.vramTotalBytes != null && engine.vramUsedBytes != null && isGpu && (
        <span className="text-sibyl-muted" title="VRAM used / total">
          {formatBytes(engine.vramUsedBytes)} / {formatBytes(engine.vramTotalBytes)}
        </span>
      )}
      {engine.contextSize != null && (
        <span className="text-sibyl-muted" title="Context window">
          {(engine.contextSize / 1024).toFixed(0)}K ctx
        </span>
      )}
    </div>
  )
}
