import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstalledModel } from '@shared/types'

const fakes = vi.hoisted(() => ({
  model: null as InstalledModel | null,
  removed: vi.fn(),
  nlc: vi.fn(),
  modelsDir: 'C:/models'
}))

vi.mock('./store', () => ({
  getInstalledModel: vi.fn(async () => fakes.model),
  removeInstalledModel: fakes.removed,
  getModelsDir: vi.fn(async () => fakes.modelsDir),
  getSettings: vi.fn(async () => ({ verifyDownloads: true, hfToken: null })),
  upsertInstalledModel: vi.fn()
}))
vi.mock('./llama', () => ({ nlc: fakes.nlc }))
vi.mock('./hf', () => ({ getRepoGgufFiles: vi.fn(async () => new Map()) }))

import {
  deleteInstalledModel,
  DownloadManager,
  resolveModelShardFiles
} from './downloads'

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sibyl-download-test-'))
  fakes.modelsDir = tempDir
  fakes.removed.mockReset()
  fakes.nlc.mockReset()
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('model deletion', () => {
  it('removes every shard in the exact multipart group and nothing else', async () => {
    const names = [
      'model-00001-of-00003.gguf',
      'model-00002-of-00003.gguf',
      'model-00003-of-00003.gguf',
      'model-00001-of-00004.gguf',
      'other-00001-of-00003.gguf'
    ]
    await Promise.all(names.map((name) => fs.writeFile(path.join(tempDir, name), name)))
    const first = path.join(tempDir, names[0])
    fakes.model = {
      id: 'downloaded',
      repoId: 'test/repo',
      filename: names[0],
      path: first,
      sizeBytes: 1,
      installedAt: '2026-01-01T00:00:00.000Z'
    }

    expect(await resolveModelShardFiles(first)).toHaveLength(3)
    await deleteInstalledModel('downloaded')

    await expect(fs.access(path.join(tempDir, names[1]))).rejects.toThrow()
    await expect(fs.access(path.join(tempDir, names[3]))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tempDir, names[4]))).resolves.toBeUndefined()
    expect(fakes.removed).toHaveBeenCalledWith('downloaded')
  })

  it('only deregisters imported multipart models', async () => {
    const file = path.join(tempDir, 'local-00001-of-00002.gguf')
    await fs.writeFile(file, 'owned by user')
    fakes.model = {
      id: 'local',
      repoId: 'local',
      filename: path.basename(file),
      path: file,
      sizeBytes: 1,
      local: true,
      installedAt: '2026-01-01T00:00:00.000Z'
    }

    await deleteInstalledModel('local')
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('owned by user')
    expect(fakes.removed).toHaveBeenCalledWith('local')
  })

  it('refuses to delete a registry path outside the managed models directory', async () => {
    const managed = path.join(tempDir, 'managed')
    await fs.mkdir(managed)
    fakes.modelsDir = managed
    const outside = path.join(tempDir, 'outside.gguf')
    await fs.writeFile(outside, 'not app-owned')
    fakes.model = {
      id: 'unsafe',
      repoId: 'test/repo',
      filename: path.basename(outside),
      path: outside,
      sizeBytes: 1,
      installedAt: '2026-01-01T00:00:00.000Z'
    }

    await expect(deleteInstalledModel('unsafe')).rejects.toThrow('outside Sibyl')
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('not app-owned')
    expect(fakes.removed).not.toHaveBeenCalled()
  })
})

describe('DownloadManager failure recovery', () => {
  it('turns a native import failure into a terminal error without leaking the job', async () => {
    fakes.nlc.mockRejectedValueOnce(new Error('native binding unavailable'))
    const manager = new DownloadManager()
    const statuses: string[] = []
    manager.on('progress', (progress) => statuses.push(progress.status))

    await manager.start('test/repo', 'model.gguf')
    await vi.waitFor(() => expect(statuses).toContain('error'))
    expect(manager.list()[0]?.error).toContain('native binding unavailable')
    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect(manager.list()).toEqual([])
  })
})
