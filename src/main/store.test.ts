import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Conversation, InstalledModel } from '@shared/types'
import type { InstalledVoice } from '@shared/tts'

const electron = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false
    })
  }
}))

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sibyl-store-test-'))
  electron.root = root
  vi.resetModules()
  const store = await import('./store')
  await store.initializePrivateVault()
  await store.setupPrivateVault('correct horse battery staple', false)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

function model(id: string): InstalledModel {
  const file = path.join(root, `${id}.gguf`)
  return {
    id,
    repoId: 'test/repo',
    filename: `${id}.gguf`,
    path: file,
    sizeBytes: 1,
    installedAt: '2026-01-01T00:00:00.000Z'
  }
}

function voice(id: string): InstalledVoice {
  return {
    id,
    name: id,
    language: 'en',
    quality: 'medium',
    modelPath: path.join(root, `${id}.onnx`),
    configPath: path.join(root, `${id}.onnx.json`),
    sizeBytes: 1,
    installedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('durable store ordering', () => {
  it('does not lose concurrent model or voice registry additions', async () => {
    const store = await import('./store')
    await Promise.all([
      ...['a', 'b', 'c'].map((id) => store.upsertInstalledModel(model(id))),
      ...['one', 'two', 'three'].map((id) => store.upsertInstalledVoice(voice(id)))
    ])
    expect((await store.listInstalledModels()).map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c'])
    expect((await store.listInstalledVoices()).map((entry) => entry.id).sort()).toEqual([
      'one',
      'three',
      'two'
    ])
  })

  it('keeps cached and restarted settings at the last durable snapshot after failure', async () => {
    let store = await import('./store')
    await store.setSettings({ theme: 'light' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    )
    await expect(store.setSettings({ theme: 'dark' })).rejects.toThrow('disk full')
    expect((await store.getSettings()).theme).toBe('light')
    rename.mockRestore()

    vi.resetModules()
    store = await import('./store')
    await store.initializePrivateVault()
    await store.unlockPrivateVault('correct horse battery staple')
    expect((await store.getSettings()).theme).toBe('light')
  })

  it('rejects an older conversation snapshot queued after a newer one', async () => {
    const store = await import('./store')
    const base: Conversation = {
      id: 'conv-1',
      title: 'new',
      modelId: null,
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z'
    }
    await store.saveConversation(base)
    await expect(
      store.saveConversation({ ...base, title: 'old', updatedAt: '2026-01-01T00:00:01.000Z' })
    ).rejects.toThrow('newer')
    expect((await store.getConversation(base.id))?.title).toBe('new')
  })

  it('does not let a stale list migration overwrite a newer saved conversation', async () => {
    const store = await import('./store')
    const { PrivateVaultStore } = await import('./vaultStore')
    const current: Conversation = {
      id: 'conv-list-race',
      title: 'new',
      modelId: null,
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z'
    }
    await store.saveConversation(current)

    vi.spyOn(PrivateVaultStore.prototype, 'listJson').mockResolvedValueOnce([
      {
        logicalId: current.id,
        value: {
          ...current,
          title: 'stale',
          updatedAt: '2026-01-01T00:00:01.000Z'
        }
      }
    ])

    expect((await store.listConversations())[0]?.title).toBe('new')
    expect((await store.getConversation(current.id))?.title).toBe('new')
  })

  it('preserves malformed registries as actionable recovery copies', async () => {
    await fs.writeFile(path.join(root, 'models.json'), '{not json')
    const store = await import('./store')
    expect(await store.listInstalledModels()).toEqual([])
    expect(store.listStorageIssues()).toEqual([
      expect.objectContaining({ resource: 'models', kind: 'malformed', recoverable: true })
    ])
    expect((await fs.readdir(root)).some((file) => file.startsWith('models.json.corrupt-'))).toBe(true)

    vi.resetModules()
    const restarted = await import('./store')
    await restarted.listInstalledModels()
    expect(restarted.listStorageIssues()).toEqual([
      expect.objectContaining({ resource: 'models', kind: 'malformed', recoverable: true })
    ])
  })

  it('migrates legacy private data without leaving plaintext or semantic filenames', async () => {
    const privatePrompt = 'private migration prompt 7e0f'
    const privateTitle = 'private migration title c135'
    await fs.rm(path.join(root, 'vault'), { recursive: true, force: true })
    await fs.mkdir(path.join(root, 'conversations'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'settings.json'),
      JSON.stringify({
        load: { gpuLayers: -1, contextSize: 8192, systemPrompt: privatePrompt },
        personas: [],
        hfTokenEnc: null
      })
    )
    await fs.writeFile(
      path.join(root, 'conversations', 'conv-migration.json'),
      JSON.stringify({
        id: 'conv-migration',
        title: privateTitle,
        modelId: null,
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
    )

    vi.resetModules()
    let store = await import('./store')
    expect(await store.initializePrivateVault()).toEqual(
      expect.objectContaining({
        state: 'uninitialized',
        migrationRequired: true,
        deviceStorageAvailable: true
      })
    )
    expect(
      await store.setupPrivateVault('correct horse battery staple', false)
    ).toEqual(expect.objectContaining({ state: 'unlocked', migrationRequired: false }))
    await expect(fs.stat(path.join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(root, 'conversations'))).rejects.toMatchObject({ code: 'ENOENT' })

    const vaultRoot = path.join(root, 'vault')
    const vaultFiles = await fs.readdir(vaultRoot, { recursive: true })
    for (const relative of vaultFiles) {
      const file = path.join(vaultRoot, relative.toString())
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      const bytes = await fs.readFile(file, 'utf8')
      expect(bytes).not.toContain(privatePrompt)
      expect(bytes).not.toContain(privateTitle)
      expect(relative.toString()).not.toContain('conv-migration')
    }

    vi.resetModules()
    store = await import('./store')
    expect((await store.initializePrivateVault()).state).toBe('locked')
    await store.unlockPrivateVault('correct horse battery staple')
    expect((await store.getSettings()).load.systemPrompt).toBe(privatePrompt)
    expect((await store.getConversation('conv-migration'))?.title).toBe(privateTitle)
  }, 30_000)

  it('fails closed and retries when legacy plaintext cleanup is interrupted', async () => {
    await fs.rm(path.join(root, 'vault'), { recursive: true, force: true })
    await fs.writeFile(
      path.join(root, 'settings.json'),
      JSON.stringify({ load: { systemPrompt: 'cleanup retry secret' }, hfTokenEnc: null })
    )
    vi.resetModules()
    const store = await import('./store')
    await store.initializePrivateVault()

    const originalRm = fs.rm.bind(fs)
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(target.toString()) === path.join(root, 'settings.json')) {
        throw Object.assign(new Error('file busy'), { code: 'EBUSY' })
      }
      return originalRm(target, options)
    })
    expect(
      await store.setupPrivateVault('correct horse battery staple', false)
    ).toEqual(
      expect.objectContaining({
        state: 'error',
        migrationRequired: true
      })
    )
    await expect(store.getSettings()).rejects.toThrow(/locked/)
    remove.mockRestore()

    expect(
      await store.unlockPrivateVault('correct horse battery staple')
    ).toEqual(expect.objectContaining({ state: 'unlocked', migrationRequired: false }))
    await expect(fs.stat(path.join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.getSettings()).load.systemPrompt).toBe('cleanup retry secret')
  }, 30_000)
})
