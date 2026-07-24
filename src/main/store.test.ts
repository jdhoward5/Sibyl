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
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sibyl-store-test-'))
  electron.root = root
  vi.resetModules()
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
})
