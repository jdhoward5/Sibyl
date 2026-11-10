import { useEffect, useState } from 'react'
import { estimateModelFit, type ModelFitEstimate } from '@shared/hardwareFit'
import { useStore } from '../store'

export function useModelFit(includeInstalled = false) {
  const hardware = useStore((s) => s.hardware)
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.installedModels)
  const contextSize = settings?.load.contextSize
  const gpuLayers = settings?.load.gpuLayers
  const gpu = settings?.gpu
  const detectedAt = hardware?.detectedAt
  const key = JSON.stringify([contextSize, gpuLayers, gpu, detectedAt, models])
  const [installedFits, setInstalledFits] = useState<{
    key: string
    fits: Record<string, ModelFitEstimate>
  }>({ key: '', fits: {} })
  useEffect(() => {
    if (!includeInstalled || contextSize == null || gpuLayers == null || !gpu || !detectedAt) return
    let cancelled = false
    void Promise.all(models.filter((model) => !model.availability || model.availability === 'available').map(async (model) => {
      try {
        const result = await window.sibyl.engine.estimateModelFit(model.id)
        return result.ok && result.data ? [model.id, result.data] as const : null
      } catch {
        return null
      }
    })).then((entries) => {
      if (!cancelled) setInstalledFits({ key, fits: Object.fromEntries(entries.filter((entry) => entry != null)) })
    })
    return () => { cancelled = true }
  }, [includeInstalled, models, contextSize, gpuLayers, gpu, detectedAt, key])
  const parameters = hardware && settings ? {
    contextSize: settings.load.contextSize,
    gpuLayers: settings.load.gpuLayers,
    gpuEnabled: settings.gpu !== 'cpu' && hardware.gpuType !== false && settings.load.gpuLayers !== 0,
    resources: hardware
  } : null
  return {
    parameters,
    fitFor: (model: Parameters<typeof estimateModelFit>[0]['model'] & { id?: string }) => parameters
      ? (model.id && installedFits.key === key ? installedFits.fits[model.id] : null)
        ?? estimateModelFit({ ...parameters, model, memoryMode: 'capacity' })
      : null
  }
}
