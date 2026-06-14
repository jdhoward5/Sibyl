import { actions, useStore } from '../../store'
import { formatBytes } from '@shared/format'
import { BoltIcon, CheckIcon, TrashIcon, FolderIcon, BoxIcon, CompassIcon } from '../../lib/icons'

export function ModelsView() {
  const models = useStore((s) => s.installedModels)
  const engine = useStore((s) => s.engine)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-oracle-border/60 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-oracle-text">Your models</h1>
          <p className="text-[13px] text-oracle-muted">
            {models.length} model{models.length === 1 ? '' : 's'} installed locally
          </p>
        </div>
        <button onClick={() => actions.setView('discover')} className="btn-surface">
          <CompassIcon size={16} /> Discover more
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {models.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <BoxIcon size={36} className="mb-3 text-oracle-muted/40" />
            <p className="mb-4 text-[14px] text-oracle-muted">No models installed yet.</p>
            <button onClick={() => actions.setView('discover')} className="btn-primary">
              <CompassIcon size={16} /> Browse Hugging Face
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {models.map((m) => {
              const isLoaded = m.id === engine.modelId
              const loading = engine.state === 'loading'
              return (
                <div key={m.id} className="card flex items-center gap-4 p-4">
                  <div
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                      isLoaded
                        ? 'bg-gradient-to-br from-oracle-accent to-oracle-accent-2 text-white'
                        : 'bg-oracle-surface-2 text-oracle-muted'
                    }`}
                  >
                    <BoxIcon size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-oracle-text">
                      {m.filename.replace(/\.gguf$/i, '')}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-oracle-muted">
                      <span className="truncate">{m.repoId}</span>
                      {m.quant && <span className="chip">{m.quant}</span>}
                      {m.paramLabel && <span className="chip">{m.paramLabel}</span>}
                      <span>{formatBytes(m.sizeBytes)}</span>
                      {m.trainContextLength && <span>{(m.trainContextLength / 1024).toFixed(0)}K ctx</span>}
                      {m.verifiedBy === 'sha256' && (
                        <span
                          className="inline-flex items-center gap-1 text-oracle-glow"
                          title="SHA-256 verified against Hugging Face's published checksum"
                        >
                          <CheckIcon size={12} /> Verified
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isLoaded ? (
                      <span className="flex items-center gap-1.5 rounded-lg bg-oracle-accent/15 px-3 py-2 text-[12px] font-medium text-oracle-glow">
                        <CheckIcon size={15} /> Loaded
                      </span>
                    ) : (
                      <button
                        onClick={() => actions.loadModel(m.id)}
                        disabled={loading}
                        className="btn-primary h-9"
                      >
                        <BoltIcon size={15} /> Load
                      </button>
                    )}
                    <button
                      onClick={() => actions.revealModel(m.id)}
                      className="btn-ghost h-9 w-9 p-0"
                      title="Show in folder"
                    >
                      <FolderIcon size={16} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete ${m.filename}? This removes the file from disk.`)) {
                          void actions.deleteModel(m.id)
                        }
                      }}
                      className="btn-ghost h-9 w-9 p-0 hover:text-red-300"
                      title="Delete model"
                    >
                      <TrashIcon size={16} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
