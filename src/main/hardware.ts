import { arch, cpus, freemem, platform, release, totalmem } from 'node:os'
import type { Llama } from 'node-llama-cpp'
import type { HardwareInfo } from '@shared/types'

/** Called inside the engine lifecycle queue so probing cannot race GPU teardown. */
export async function readHardware(getBackend: () => Promise<Llama>): Promise<HardwareInfo> {
  const processors = cpus()
  const info: HardwareInfo = {
    cpuModel: processors[0]?.model.trim() || 'Unknown CPU',
    logicalCores: processors.length,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    systemMemoryTotalBytes: totalmem(),
    systemMemoryFreeBytes: freemem(),
    gpuType: null,
    gpuNames: [],
    vramTotalBytes: null,
    vramUsedBytes: null,
    unifiedMemory: platform() === 'darwin' && arch() === 'arm64',
    detectedAt: new Date().toISOString()
  }
  try {
    const llama = await getBackend()
    info.gpuType = llama.gpu
    if (llama.gpu) {
      const [names, memory] = await Promise.allSettled([
        llama.getGpuDeviceNames(),
        llama.getVramState()
      ])
      if (names.status === 'fulfilled') info.gpuNames = names.value
      if (memory.status === 'fulfilled' && Number.isFinite(memory.value.total) && memory.value.total > 0) {
        info.vramTotalBytes = memory.value.total
        info.vramUsedBytes = Number.isFinite(memory.value.used)
          ? Math.max(0, memory.value.used)
          : null
        info.unifiedMemory ||= memory.value.unifiedSize >= memory.value.total
      } else {
        info.detectionError = 'GPU memory could not be measured. GPU fit estimates are unavailable.'
      }
    }
  } catch {
    // Never surface native exception text, which may include filesystem paths.
    info.detectionError = 'The inference backend could not be detected. CPU and system memory are still shown.'
  }
  // Native initialization may take a few seconds; sample RAM at completion.
  info.systemMemoryFreeBytes = freemem()
  info.detectedAt = new Date().toISOString()
  return info
}
