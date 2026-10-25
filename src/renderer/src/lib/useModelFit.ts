import { estimateModelFit } from '@shared/hardwareFit'
import { useStore } from '../store'

export function useModelFit() {
  const hardware = useStore((s) => s.hardware)
  const settings = useStore((s) => s.settings)
  const parameters = hardware && settings ? {
    contextSize: settings.load.contextSize,
    gpuLayers: settings.load.gpuLayers,
    gpuEnabled: settings.gpu !== 'cpu' && hardware.gpuType !== false && settings.load.gpuLayers !== 0,
    resources: hardware
  } : null
  return {
    parameters,
    fitFor: (model: Parameters<typeof estimateModelFit>[0]['model']) => parameters
      ? estimateModelFit({ ...parameters, model, memoryMode: 'capacity' })
      : null
  }
}
