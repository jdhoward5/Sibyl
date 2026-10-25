import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { InstalledModel } from '@shared/types'
import type { RepoFileInfo } from './hf'

const fakes = vi.hoisted(() => ({
  model: null as InstalledModel | null,
  models: [] as InstalledModel[],
  fileInfo: new Map<string, RepoFileInfo>(),
  upsert: vi.fn(),
  removed: vi.fn(),
  nlc: vi.fn(),
  modelsDir: 'C:/models'
}))

vi.mock('./store', () => ({
  getInstalledModel: vi.fn(async () => fakes.model),
  listInstalledModels: vi.fn(async () => fakes.models),
  removeInstalledModel: fakes.removed,
  getModelsDir: vi.fn(async () => fakes.modelsDir),
  getSettings: vi.fn(async () => ({ verifyDownloads: true, hfToken: null })),
  upsertInstalledModel: fakes.upsert
}))
vi.mock('./llama', () => ({ nlc: fakes.nlc }))
vi.mock('./hf', () => ({ getRepoGgufFiles: vi.fn(async () => fakes.fileInfo) }))

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
  fakes.upsert.mockReset()
  fakes.model = null
  fakes.models = []
  fakes.fileInfo = new Map()
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

  it('keeps shared files when removing a legacy duplicate shard entry', async () => {
    const first = path.join(tempDir, 'model-00001-of-00002.gguf')
    const second = path.join(tempDir, 'model-00002-of-00002.gguf')
    await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second')])
    fakes.model = {
      id: 'legacy-second', repoId: 'test/repo', filename: path.basename(second),
      path: first, sizeBytes: 11, installedAt: '2026-01-01T00:00:00.000Z'
    }
    fakes.models = [fakes.model, { ...fakes.model, id: 'canonical-first', filename: path.basename(first) }]
    await deleteInstalledModel('legacy-second')
    await expect(fs.readFile(first, 'utf8')).resolves.toBe('first')
    await expect(fs.readFile(second, 'utf8')).resolves.toBe('second')
    expect(fakes.removed).toHaveBeenCalledWith('legacy-second')

    fakes.model = fakes.models[1]
    fakes.models = [fakes.model]
    await deleteInstalledModel('canonical-first')
    await expect(fs.access(first)).rejects.toThrow()
    await expect(fs.access(second)).rejects.toThrow()
  })

  it('preserves a downloaded group still referenced by a local import', async () => {
    const first = path.join(tempDir, 'model-00001-of-00002.gguf')
    const second = path.join(tempDir, 'model-00002-of-00002.gguf')
    await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second')])
    fakes.model = {
      id: 'download', repoId: 'test/repo', filename: path.basename(first),
      path: first, sizeBytes: 11, installedAt: '2026-01-01T00:00:00.000Z'
    }
    fakes.models = [fakes.model, { ...fakes.model, id: 'local', path: second, local: true }]
    await deleteInstalledModel('download')
    await expect(fs.access(first)).resolves.toBeUndefined()
    await expect(fs.access(second)).resolves.toBeUndefined()
  })
})

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function fakeDownload(
  files: { remote: string; local: string; content: string; checksum?: string }[],
  skipExisting = false
) {
  for (const file of files) {
    fakes.fileInfo.set(file.remote, { size: Buffer.byteLength(file.content), sha256: file.checksum ?? sha256(file.content) })
  }
  const createModelDownloader = vi.fn(async (options: { onProgress: (progress: { totalSize: number; downloadedSize: number }) => void }) => ({
    download: vi.fn(async () => {
      await Promise.all(files.map(async (file) => {
        const target = path.join(tempDir, file.local)
        if (skipExisting && await fs.access(target).then(() => true).catch(() => false)) return
        await fs.writeFile(target, file.content)
      }))
      const size = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
      options.onProgress({ totalSize: size, downloadedSize: size })
      return path.join(tempDir, files[0].local)
    })
  }))
  fakes.nlc.mockResolvedValue({ createModelDownloader })
  return createModelDownloader
}

async function runDownload(filename: string) {
  const manager = new DownloadManager()
  await manager.start('test/repo', filename)
  await vi.waitFor(() => expect(['completed', 'error', 'cancelled']).toContain(manager.list()[0]?.status))
  return manager.list()[0]
}

describe('download identity and checksum integrity', () => {
  it('verifies the checksum when the downloader prefixes the local filename', async () => {
    fakeDownload([{ remote: 'model.gguf', local: 'hf_test_repo_model.gguf', content: 'valid-model' }])
    expect((await runDownload('model.gguf')).status).toBe('completed')
    expect(fakes.upsert).toHaveBeenCalledWith(expect.objectContaining({ verified: true, verifiedBy: 'sha256' }))
  })

  it('rejects same-size corrupt bytes even with a prefixed local filename', async () => {
    const local = 'hf_test_repo_model.gguf'
    fakeDownload([{ remote: 'model.gguf', local, content: 'WRONG', checksum: sha256('RIGHT') }])
    expect((await runDownload('model.gguf')).error).toMatch(/Checksum verification failed/)
    expect(fakes.upsert).not.toHaveBeenCalled()
    await expect(fs.access(path.join(tempDir, local))).rejects.toThrow()
  })

  it.each([
    { kind: 'legacy shard alias', local: false },
    { kind: 'local import', local: true }
  ])('preserves a reused $kind after a checksum mismatch', async ({ local }) => {
    const first = 'hf_test_model-00001-of-00002.gguf'
    const second = 'hf_test_model-00002-of-00002.gguf'
    await Promise.all([
      fs.writeFile(path.join(tempDir, first), 'first'),
      fs.writeFile(path.join(tempDir, second), 'LOCAL')
    ])
    fakes.models = [{
      id: local ? 'local-import' : 'legacy-second', repoId: local ? 'local' : 'test/repo',
      filename: 'model-00002-of-00002.gguf', path: path.join(tempDir, second),
      local, sizeBytes: 10, installedAt: '2026-01-01T00:00:00.000Z'
    }]
    fakeDownload([
      { remote: 'model-00001-of-00002.gguf', local: first, content: 'first' },
      { remote: 'model-00002-of-00002.gguf', local: second, content: 'NEWER' }
    ], true)
    const result = await runDownload('model-00001-of-00002.gguf')
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/Checksum verification failed/)
    expect(result.error).toMatch(/Existing library files were preserved/)
    expect(result.error).not.toMatch(/removed/)
    await expect(fs.readFile(path.join(tempDir, first), 'utf8')).resolves.toBe('first')
    await expect(fs.readFile(path.join(tempDir, second), 'utf8')).resolves.toBe('LOCAL')
    expect(fakes.upsert).not.toHaveBeenCalled()
    expect(fakes.removed).not.toHaveBeenCalled()
  })

  it('preserves registered files when a reused file has the wrong size', async () => {
    const local = 'hf_test_repo_model.gguf'
    const target = path.join(tempDir, local)
    await fs.writeFile(target, 'existing-local-file')
    fakes.models = [{
      id: 'local-import', repoId: 'local', filename: local, path: target,
      local: true, sizeBytes: 19, installedAt: '2026-01-01T00:00:00.000Z'
    }]
    fakeDownload([{ remote: 'model.gguf', local, content: 'new' }], true)
    expect((await runDownload('model.gguf')).error).toMatch(/wrong size.*Existing library files were preserved/)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('existing-local-file')
    expect(fakes.upsert).not.toHaveBeenCalled()
  })

  it('verifies every shard using full remote paths and registers the canonical model', async () => {
    const first = 'Q4/model-00001-of-00002.gguf'
    const second = 'Q4/model-00002-of-00002.gguf'
    const createDownloader = fakeDownload([
      { remote: first, local: 'hf_test_repo_Q4_model-00001-of-00002.gguf', content: 'first' },
      { remote: second, local: 'hf_test_repo_Q4_model-00002-of-00002.gguf', content: 'second' }
    ])
    fakes.fileInfo.set('other/model-00001-of-00002.gguf', { size: 5, sha256: sha256('WRONG') })
    expect((await runDownload(second)).status).toBe('completed')
    expect(createDownloader).toHaveBeenCalledWith(expect.objectContaining({ modelUri: `hf:test/repo/${first}` }))
    expect(fakes.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: `test/repo/${first}`, filename: first, sizeBytes: 11, verifiedBy: 'sha256'
    }))
  })

  it('rejects corruption in a later shard and removes the whole downloaded group', async () => {
    fakeDownload([
      { remote: 'model-00001-of-00002.gguf', local: 'hf_test_model-00001-of-00002.gguf', content: 'first' },
      { remote: 'model-00002-of-00002.gguf', local: 'hf_test_model-00002-of-00002.gguf', content: 'WRONG', checksum: sha256('RIGHT') }
    ])
    expect((await runDownload('model-00001-of-00002.gguf')).status).toBe('error')
    expect(fakes.upsert).not.toHaveBeenCalled()
    expect(await fs.readdir(tempDir)).toEqual([])
  })

  it('retains shared existing files when registration of the canonical entry fails', async () => {
    const local = 'hf_test_model-00001-of-00002.gguf'
    fakeDownload([
      { remote: 'model-00001-of-00002.gguf', local, content: 'first' },
      { remote: 'model-00002-of-00002.gguf', local: 'hf_test_model-00002-of-00002.gguf', content: 'second' }
    ])
    fakes.models = [{
      id: 'legacy-second', repoId: 'test/repo', filename: 'model-00002-of-00002.gguf',
      path: path.join(tempDir, local), sizeBytes: 11, installedAt: '2026-01-01T00:00:00.000Z'
    }]
    fakes.upsert.mockRejectedValueOnce(new Error('Registry write failed'))
    expect((await runDownload('model-00001-of-00002.gguf')).status).toBe('error')
    await expect(fs.readFile(path.join(tempDir, local), 'utf8')).resolves.toBe('first')
  })

  it('deduplicates shard requests and accepts cancellation through a legacy shard id', async () => {
    let release!: () => void
    const setup = new Promise<void>((resolve) => { release = resolve })
    const download = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted()
      throw new Error('Expected cancellation')
    })
    const createDownloader = vi.fn(async () => ({ download }))
    fakes.nlc.mockImplementation(async () => { await setup; return { createModelDownloader: createDownloader } })
    const manager = new DownloadManager()
    const first = await manager.start('test/repo', 'model-00001-of-00002.gguf')
    const second = await manager.start('test/repo', 'model-00002-of-00002.gguf')
    expect(first).toEqual(second)
    expect(manager.list()).toHaveLength(1)
    expect(manager.cancel('test/repo/model-00002-of-00002.gguf')).toBe(true)
    release()
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('cancelled'))
    expect(createDownloader).not.toHaveBeenCalled()
    expect(fakes.upsert).not.toHaveBeenCalled()
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
