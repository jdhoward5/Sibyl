import { actions, useStore } from '../../store'
import { formatBytes } from '@shared/format'
import { CheckIcon, TrashIcon, FolderIcon, BoxIcon, CompassIcon, PlusIcon } from '../../lib/icons'

export function ModelsView() {
  const models = useStore((s) => s.installedModels)
  const engine = useStore((s) => s.engine)
  const totalBytes = models.reduce((sum, m) => sum + m.sizeBytes, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[840px] px-8 py-7">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <div className="eyebrow mb-2 text-sibyl-accent">// Models</div>
              <h1 className="font-mono text-[24px] font-extrabold text-sibyl-text">Installed</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[12px] text-sibyl-muted">
                {models.length} {models.length === 1 ? 'model' : 'models'}
                {totalBytes > 0 && ` · ${formatBytes(totalBytes)} on disk`}
              </span>
              <button onClick={() => void actions.importLocalModel()} className="btn-surface h-9" title="Use a .gguf you already have on disk">
                <PlusIcon size={16} /> Add local model
              </button>
              <button onClick={() => actions.setView('discover')} className="btn-surface h-9">
                <CompassIcon size={16} /> Discover
              </button>
            </div>
          </div>

          {models.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <BoxIcon size={36} className="mb-3 text-sibyl-muted/40" />
              <p className="mb-4 text-[14px] text-sibyl-muted">No models yet — download one, or add a file you already have.</p>
              <div className="flex items-center gap-2.5">
                <button onClick={() => actions.setView('discover')} className="btn-primary">
                  <CompassIcon size={16} /> Browse Hugging Face
                </button>
                <button onClick={() => void actions.importLocalModel()} className="btn-surface">
                  <PlusIcon size={16} /> Add local model
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="eyebrow mb-2.5 text-[11px]">On this machine</div>
              <div className="flex flex-col gap-2.5">
                {models.map((m) => {
                  const isLoaded = m.id === engine.modelId
                  const loading = engine.state === 'loading'
                  const meta = [
                    m.local ? null : m.repoId.split('/')[0],
                    m.quant,
                    formatBytes(m.sizeBytes),
                    m.trainContextLength ? `${(m.trainContextLength / 1024).toFixed(0)}K ctx` : null
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <div
                      key={m.id}
                      className={`flex items-center gap-4 rounded-lg border bg-sibyl-surface px-4 py-3.5 ${
                        isLoaded ? 'border-emerald-400/25' : 'border-sibyl-border'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <span className="truncate font-mono text-[14px] font-bold text-sibyl-text">
                            {m.filename.replace(/\.gguf$/i, '')}
                          </span>
                          {isLoaded && (
                            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-emerald-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px] shadow-emerald-300" />
                              loaded
                            </span>
                          )}
                          {m.verifiedBy === 'sha256' && (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-sibyl-glow"
                              title="SHA-256 verified against Hugging Face's published checksum"
                            >
                              <CheckIcon size={11} /> verified
                            </span>
                          )}
                          {m.local && (
                            <span
                              className="shrink-0 rounded-full border border-sibyl-border px-2 py-px font-mono text-[10px] text-sibyl-muted"
                              title="Imported from a file on your disk; removing it won't delete the file"
                            >
                              local
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 truncate font-mono text-[11px] text-sibyl-muted">{meta}</div>
                      </div>
                      {isLoaded ? (
                        <button onClick={() => void actions.unloadModel()} className="btn-surface h-[34px]">
                          Eject
                        </button>
                      ) : (
                        <button onClick={() => actions.loadModel(m.id)} disabled={loading} className="btn-primary h-[34px]">
                          Load
                        </button>
                      )}
                      <button onClick={() => actions.revealModel(m.id)} className="btn-ghost h-[34px] w-[34px] p-0" title="Show in folder">
                        <FolderIcon size={16} />
                      </button>
                      <button
                        onClick={() => {
                          const msg = m.local
                            ? `Remove ${m.filename} from your library? The file stays on disk.`
                            : `Delete ${m.filename}? This removes the file from disk.`
                          if (confirm(msg)) void actions.deleteModel(m.id)
                        }}
                        className="btn-ghost h-[34px] w-[34px] p-0 hover:text-red-300"
                        title={m.local ? 'Remove from library (keeps the file)' : 'Delete model'}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
