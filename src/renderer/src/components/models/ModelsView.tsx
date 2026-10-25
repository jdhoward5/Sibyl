import { useState } from 'react'
import { actions, useStore } from '../../store'
import { formatBytes } from '@shared/format'
import { CheckIcon, TrashIcon, FolderIcon, BoxIcon, PlusIcon } from '../../lib/icons'
import { useModelFit } from '../../lib/useModelFit'
import { ModelFitHint } from './ModelFitHint'
import { DiscoverView } from '../discover/DiscoverView'
import { HardwarePanel } from './HardwarePanel'

type ModelsTab = 'installed' | 'browse'

export function ModelsView() {
  const [tab, setTab] = useState<ModelsTab>('installed')
  const models = useStore((state) => state.installedModels)
  const engine = useStore((state) => state.engine)
  const { fitFor, parameters } = useModelFit()
  const totalBytes = models.reduce((sum, model) => sum + model.sizeBytes, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-sibyl-border/60 px-8 py-5">
        <div className="mx-auto flex max-w-[920px] items-end justify-between gap-6">
          <div>
            <div className="eyebrow mb-2 text-sibyl-accent">Models</div>
            <h1 className="display-title text-[28px]">
              {tab === 'installed' ? 'On this machine' : 'Browse models'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {tab === 'installed' && (
              <>
                <span className="font-mono text-[11px] text-sibyl-muted">
                  {models.length} {models.length === 1 ? 'model' : 'models'}
                  {totalBytes > 0 && ` · ${formatBytes(totalBytes)}`}
                </span>
                <button
                  onClick={() => void actions.importLocalModel()}
                  className="btn-surface h-9"
                  title="Use a .gguf already on disk"
                >
                  <PlusIcon size={16} /> Add local model
                </button>
              </>
            )}
            <div className="segmented-control" aria-label="Model library view">
              <button
                onClick={() => setTab('installed')}
                aria-pressed={tab === 'installed'}
                className={tab === 'installed' ? 'is-active' : ''}
              >
                Installed
              </button>
              <button
                onClick={() => setTab('browse')}
                aria-pressed={tab === 'browse'}
                className={tab === 'browse' ? 'is-active' : ''}
              >
                Browse
              </button>
            </div>
          </div>
        </div>
      </div>

      {tab === 'browse' ? (
        <DiscoverView embedded />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[920px] px-8 py-6">
            <HardwarePanel />
            {models.length === 0 ? (
              <div className="empty-stage">
                <BoxIcon size={34} className="text-sibyl-accent/70" />
                <h2 className="mt-4 text-[17px] font-semibold text-sibyl-text">
                  No local models yet
                </h2>
                <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-sibyl-muted">
                  Browse for a GGUF model that fits this machine, or add one you already keep on disk.
                </p>
                <div className="mt-5 flex items-center gap-2.5">
                  <button onClick={() => setTab('browse')} className="btn-primary">
                    Browse models
                  </button>
                  <button onClick={() => void actions.importLocalModel()} className="btn-surface">
                    <PlusIcon size={16} /> Add local model
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {models.map((model) => {
                  const isLoaded = model.id === engine.modelId
                  const loading = engine.state === 'loading'
                  const unavailable =
                    model.availability && model.availability !== 'available'
                  const meta = [
                    model.local ? null : model.repoId.split('/')[0],
                    model.quant,
                    formatBytes(model.sizeBytes),
                    model.trainContextLength
                      ? `${(model.trainContextLength / 1024).toFixed(0)}K context`
                      : null
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  const fit = fitFor(model)

                  return (
                    <article
                      key={model.id}
                      className={`card flex items-center gap-4 px-4 py-3.5 ${
                        isLoaded ? 'border-sibyl-accent/45' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <span className="truncate text-[14px] font-semibold text-sibyl-text">
                            {model.filename.replace(/\.gguf$/i, '')}
                          </span>
                          {isLoaded && (
                            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-sibyl-accent">
                              <span className="h-1.5 w-1.5 rounded-full bg-sibyl-accent" />
                              active
                            </span>
                          )}
                          {model.verifiedBy === 'sha256' && (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-sibyl-glow"
                              title="SHA-256 verified against Hugging Face's published checksum"
                            >
                              <CheckIcon size={11} /> verified
                            </span>
                          )}
                          {model.local && (
                            <span className="chip" title="Removing this entry keeps the file on disk">
                              local
                            </span>
                          )}
                          {unavailable && (
                            <span
                              className="rounded-full border border-amber-400/30 px-2 py-px font-mono text-[10px] text-amber-300"
                              title={model.availabilityError}
                            >
                              {model.availability}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 truncate font-mono text-[10.5px] text-sibyl-muted">
                          {meta}
                        </div>
                        <ModelFitHint fit={fit} unified={parameters?.resources.unifiedMemory} />
                      </div>
                      {isLoaded ? (
                        <button onClick={() => void actions.unloadModel()} className="btn-surface h-[34px]">
                          Eject
                        </button>
                      ) : unavailable ? (
                        <button onClick={() => void actions.locateModel(model.id)} className="btn-surface h-[34px]">
                          Locate again
                        </button>
                      ) : (
                        <button
                          onClick={() => actions.loadModel(model.id)}
                          disabled={loading}
                          className="btn-primary h-[34px]"
                        >
                          Load
                        </button>
                      )}
                      <button
                        onClick={() => actions.revealModel(model.id)}
                        disabled={Boolean(unavailable)}
                        className="btn-ghost h-[34px] w-[34px] p-0 disabled:opacity-40"
                        title="Show in folder"
                      >
                        <FolderIcon size={16} />
                      </button>
                      <button
                        onClick={() => {
                          const message = model.local
                            ? `Remove ${model.filename} from your library? The file stays on disk.`
                            : `Delete ${model.filename}? This removes the file from disk.`
                          if (confirm(message)) void actions.deleteModel(model.id)
                        }}
                        disabled={loading}
                        className="btn-ghost h-[34px] w-[34px] p-0 hover:text-red-300 disabled:opacity-40"
                        title={model.local ? 'Remove from library' : 'Delete model'}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
