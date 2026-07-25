import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrivateVaultStore, type DeviceKeyProtector } from './vaultStore'
import type { PasskeyProvider } from './passkey'
import {
  parseVaultHeader,
  unlockVaultWithPassphrase
} from './vault'

let parent: string
let root: string

function xorProtector(): DeviceKeyProtector {
  const deviceKey = Buffer.alloc(32, 0xa5)
  const transform = async (input: Buffer): Promise<Buffer> => {
    const output = Buffer.alloc(input.length)
    for (let i = 0; i < input.length; i += 1) output[i] = input[i] ^ deviceKey[i % deviceKey.length]
    return output
  }
  return {
    available: async () => true,
    protect: transform,
    unprotect: async (input) => ({ key: await transform(input), shouldReprotect: false })
  }
}

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sibyl-vault-store-'))
  root = path.join(parent, 'vault')
})

afterEach(async () => {
  await fs.rm(parent, { recursive: true, force: true })
})

describe('private vault store', () => {
  it('reports device storage availability before first-run enrollment', async () => {
    const store = new PrivateVaultStore(root, xorProtector())
    expect(await store.initialize()).toEqual(
      expect.objectContaining({
        state: 'uninitialized',
        deviceStorageAvailable: true
      })
    )
  })

  it('creates only ciphertext, restarts seamlessly, and unlocks by recovery passphrase', async () => {
    const protector = xorProtector()
    const store = new PrivateVaultStore(root, protector)
    expect((await store.initialize()).state).toBe('uninitialized')
    await store.setup('correct horse battery staple', true, [
      {
        kind: 'settings',
        logicalId: 'main',
        value: { systemPrompt: 'a private prompt', personas: ['Ada'] }
      },
      {
        kind: 'conversation',
        logicalId: 'conv-1',
        value: { title: 'Secret scene', messages: ['private words'] }
      }
    ])

    const allFiles = await fs.readdir(root, { recursive: true })
    for (const relative of allFiles) {
      const file = path.join(root, relative.toString())
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      const serialized = await fs.readFile(file, 'utf8')
      expect(serialized).not.toContain('a private prompt')
      expect(serialized).not.toContain('Secret scene')
      expect(serialized).not.toContain('private words')
      expect(serialized).not.toContain('conv-1')
    }

    store.lock()
    expect(store.status().state).toBe('locked')
    const restarted = new PrivateVaultStore(root, protector)
    expect((await restarted.initialize()).state).toBe('unlocked')
    expect(await restarted.readJson('conversation', 'conv-1')).toEqual({
      title: 'Secret scene',
      messages: ['private words']
    })
    restarted.lock()
    await restarted.unlockWithPassphrase('correct horse battery staple')
    expect(await restarted.readJson('settings', 'main')).toEqual({
      systemPrompt: 'a private prompt',
      personas: ['Ada']
    })
  }, 30_000)

  it('stays unlocked when refreshing an authenticated device wrap fails', async () => {
    const original = xorProtector()
    const store = new PrivateVaultStore(root, original)
    await store.initialize()
    await store.setup('correct horse battery staple', true, [
      { kind: 'settings', logicalId: 'main', value: { private: true } }
    ])
    store.lock()

    const refreshFailure: DeviceKeyProtector = {
      available: async () => true,
      protect: async () => {
        throw new Error('device storage refresh failed')
      },
      unprotect: async (wrapped) => {
        const result = await original.unprotect(wrapped)
        return { key: result.key, shouldReprotect: true }
      }
    }
    const restarted = new PrivateVaultStore(root, refreshFailure)
    expect(await restarted.initialize()).toEqual(
      expect.objectContaining({
        state: 'unlocked',
        error:
          'Sibyl unlocked the vault, but could not refresh secure device storage.'
      })
    )
    expect(await restarted.readJson('settings', 'main')).toEqual({
      private: true
    })
  }, 30_000)

  it('commits portable imports through one index swap and rolls back staged records', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { version: 'original' } }
    ])
    await store.writeJsonBatch([
      { kind: 'settings', logicalId: 'main', value: { version: 'imported' } },
      { kind: 'conversation', logicalId: 'conversation-1', value: { private: 'one' } },
      { kind: 'conversation', logicalId: 'conversation-2', value: { private: 'two' } }
    ])
    expect(await store.readJson('settings', 'main')).toEqual({ version: 'imported' })
    expect((await store.listJson('conversation')).map((item) => item.logicalId).sort()).toEqual([
      'conversation-1',
      'conversation-2'
    ])

    await expect(
      store.writeJsonBatch([
        { kind: 'conversation', logicalId: 'staged-only', value: { private: 'staged' } },
        { kind: 'conversation', logicalId: 'invalid', value: { unsupported: 1n } }
      ])
    ).rejects.toBeDefined()
    expect(await store.readJson('conversation', 'staged-only')).toBeNull()
    expect(await store.readJson('settings', 'main')).toEqual({ version: 'imported' })
  }, 60_000)

  it('applies encrypted backup-retention controls and verifies recovery without restoring', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { revision: 0 } }
    ])
    store.setBackupRetention(1)
    await store.writeJson('settings', 'main', { revision: 1 })
    await store.writeJson('settings', 'main', { revision: 2 })
    expect(await store.listBackups()).toHaveLength(1)
    await expect(store.verifyRecovery()).resolves.toEqual({
      currentRecords: 1,
      validBackups: 1
    })
  }, 60_000)

  it('removes obsolete unlock credentials from retained recovery snapshots', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('the original recovery passphrase', false, [
      { kind: 'settings', logicalId: 'main', value: { revision: 0 } }
    ])
    await store.writeJson('settings', 'main', { revision: 1 })
    const [backup] = await store.listBackups()
    if (!backup) throw new Error('missing backup')

    await store.changeRecoveryPassphrase('the replacement recovery passphrase')

    const backupHeader = parseVaultHeader(
      JSON.parse(
        await fs.readFile(
          path.join(parent, 'vault-backups', backup.id, 'header.json'),
          'utf8'
        )
      ) as unknown
    )
    await expect(
      unlockVaultWithPassphrase(backupHeader, 'the original recovery passphrase')
    ).rejects.toMatchObject({ code: 'UNLOCK_FAILED' })
    const recovered = await unlockVaultWithPassphrase(
      backupHeader,
      'the replacement recovery passphrase'
    )
    recovered.destroy()
  }, 60_000)

  it('requires a passphrase after device credentials disappear', async () => {
    const store = new PrivateVaultStore(root, xorProtector())
    await store.initialize()
    await store.setup('correct horse battery staple', true, [
      { kind: 'settings', logicalId: 'main', value: { private: true } }
    ])
    store.lock()

    const unavailable: DeviceKeyProtector = {
      available: async () => false,
      protect: async () => {
        throw new Error('unavailable')
      },
      unprotect: async () => {
        throw new Error('unavailable')
      }
    }
    const copied = new PrivateVaultStore(root, unavailable)
    expect((await copied.initialize()).state).toBe('locked')
    const now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await expect(copied.unlockWithPassphrase('wrong passphrase')).rejects.toMatchObject({
      code: 'UNLOCK_FAILED'
    })
    clock.mockReturnValue(now + 1_000)
    expect((await copied.unlockWithPassphrase('correct horse battery staple')).state).toBe(
      'unlocked'
    )
    clock.mockRestore()
  }, 30_000)

  it('enrolls, unlocks, and removes a capability-gated passkey slot', async () => {
    const credentialId = Buffer.alloc(32, 0x11)
    const salt = Buffer.alloc(32, 0x22)
    const output = Buffer.alloc(32, 0x33)
    const provider: PasskeyProvider = {
      available: async () => true,
      enroll: async () => ({
        credentialId: Buffer.from(credentialId),
        salt: Buffer.from(salt),
        prfOutput: Buffer.from(output)
      }),
      evaluate: async (receivedCredential, receivedSalt) => {
        expect(receivedCredential).toEqual(credentialId)
        expect(receivedSalt).toEqual(salt)
        return Buffer.from(output)
      }
    }
    const store = new PrivateVaultStore(root, undefined, provider)
    expect(await store.initialize()).toEqual(
      expect.objectContaining({ passkeyAvailable: true })
    )
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { private: true } }
    ])
    expect(await store.setPasskey(true)).toEqual(
      expect.objectContaining({ hasPasskeySlot: true })
    )
    store.lock()
    expect((await store.unlockWithPasskey()).state).toBe('unlocked')
    expect(await store.readJson('settings', 'main')).toEqual({ private: true })
    expect(await store.setPasskey(false)).toEqual(
      expect.objectContaining({ hasPasskeySlot: false })
    )
    credentialId.fill(0)
    salt.fill(0)
    output.fill(0)
  }, 30_000)

  it('backs off repeated unlock attempts in memory', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [])
    store.lock()
    const now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await expect(store.unlockWithPassphrase('wrong passphrase')).rejects.toMatchObject({
      code: 'UNLOCK_FAILED'
    })
    await expect(
      store.unlockWithPassphrase('correct horse battery staple')
    ).rejects.toThrow(/Wait 1 second/)
    clock.mockReturnValue(now + 1_000)
    expect(
      (await store.unlockWithPassphrase('correct horse battery staple')).state
    ).toBe('unlocked')
    clock.mockRestore()
  }, 30_000)

  it('changes the recovery passphrase atomically', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { private: true } }
    ])
    await store.changeRecoveryPassphrase('the replacement recovery passphrase')
    store.lock()
    const now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await expect(store.unlockWithPassphrase('correct horse battery staple')).rejects.toMatchObject({
      code: 'UNLOCK_FAILED'
    })
    clock.mockReturnValue(now + 1_000)
    await store.unlockWithPassphrase('the replacement recovery passphrase')
    expect(await store.readJson('settings', 'main')).toEqual({ private: true })
    clock.mockRestore()
  }, 30_000)

  it('atomically advances the encrypted index and detects stale-record replay', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'conversation', logicalId: 'conv-1', value: { version: 1 } }
    ])
    const recordsDir = path.join(root, 'records')
    const oldFile = (await fs.readdir(recordsDir))[0]
    const oldCiphertext = await fs.readFile(path.join(recordsDir, oldFile), 'utf8')

    await store.writeJson('conversation', 'conv-1', { version: 2 })
    expect(await store.readJson('conversation', 'conv-1')).toEqual({ version: 2 })
    const currentFile = (await fs.readdir(recordsDir))[0]
    await fs.writeFile(path.join(recordsDir, currentFile), oldCiphertext, 'utf8')
    await expect(store.readJson('conversation', 'conv-1')).rejects.toMatchObject({
      code: 'RECORD_TAMPERED'
    })
  }, 30_000)

  it('writes and deletes records without exposing logical identities in filenames', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [])
    await store.writeJson('conversation', 'sensitive-conversation-id', { title: 'private' })
    expect(await store.listJson('conversation')).toEqual([
      { logicalId: 'sensitive-conversation-id', value: { title: 'private' } }
    ])
    const files = await fs.readdir(path.join(root, 'records'))
    expect(files.join(' ')).not.toContain('sensitive-conversation-id')
    await store.delete('conversation', 'sensitive-conversation-id')
    expect(await store.listJson('conversation')).toEqual([])
  }, 30_000)

  it('keeps three rotating ciphertext-only backups without semantic filenames', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'conversation', logicalId: 'conv-secret', value: { title: 'secret zero' } }
    ])
    for (let version = 1; version <= 4; version += 1) {
      await store.writeJson('conversation', 'conv-secret', {
        title: `secret version ${version}`
      })
    }

    const backups = path.join(parent, 'vault-backups')
    const generations = (await fs.readdir(backups)).filter((name) => name.endsWith('.svb'))
    expect(generations).toHaveLength(3)
    for (const generation of generations) {
      expect(generation).toMatch(/^[A-Za-z0-9_-]{22}\.svb$/)
      const files = await fs.readdir(path.join(backups, generation), { recursive: true })
      for (const relative of files) {
        const file = path.join(backups, generation, relative.toString())
        if (!(await fs.stat(file)).isFile()) continue
        const serialized = await fs.readFile(file, 'utf8')
        expect(serialized).not.toContain('conv-secret')
        expect(serialized).not.toContain('secret version')
        expect(serialized).not.toContain('secret zero')
      }
    }
  }, 30_000)

  it('does not commit a mutation when its protective backup cannot be created', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { version: 1 } }
    ])
    const copy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    )
    await expect(
      store.writeJson('settings', 'main', { version: 2 })
    ).rejects.toThrow('disk full')
    copy.mockRestore()
    expect(await store.readJson('settings', 'main')).toEqual({ version: 1 })
  }, 30_000)

  it('restores a verified backup without overwriting the last good generation', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'conversation', logicalId: 'conv-1', value: { version: 0 } }
    ])
    await store.writeJson('conversation', 'conv-1', { version: 1 })
    await store.writeJson('conversation', 'conv-1', { version: 2 })
    const backups = await store.listBackups()
    expect(backups).toHaveLength(2)
    expect(backups.every((backup) => backup.valid)).toBe(true)

    const oldest = backups.at(-1)
    if (!oldest) throw new Error('missing backup')
    await store.restoreBackup(oldest.id)
    expect(await store.readJson('conversation', 'conv-1')).toEqual({ version: 0 })
    expect((await store.listBackups()).length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('rejects a tampered backup and leaves current data untouched', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'conversation', logicalId: 'conv-1', value: { version: 0 } }
    ])
    await store.writeJson('conversation', 'conv-1', { version: 1 })
    const [backup] = await store.listBackups()
    if (!backup) throw new Error('missing backup')
    const backupRecords = path.join(parent, 'vault-backups', backup.id, 'records')
    const [record] = await fs.readdir(backupRecords)
    await fs.writeFile(path.join(backupRecords, record), 'tampered', 'utf8')

    expect((await store.listBackups())[0]?.valid).toBe(false)
    await expect(store.restoreBackup(backup.id)).rejects.toBeDefined()
    expect(await store.readJson('conversation', 'conv-1')).toEqual({ version: 1 })
  }, 30_000)

  it('detects authenticated-header mismatches in live recovery drills and backups', async () => {
    const store = new PrivateVaultStore(root)
    await store.initialize()
    await store.setup('correct horse battery staple', false, [
      { kind: 'settings', logicalId: 'main', value: { revision: 0 } }
    ])
    await store.writeJson('settings', 'main', { revision: 1 })
    const [backup] = await store.listBackups()
    if (!backup) throw new Error('missing backup')
    const backupHeader = path.join(parent, 'vault-backups', backup.id, 'header.json')
    const parsed = JSON.parse(await fs.readFile(backupHeader, 'utf8'))
    parsed.keyCheck = Buffer.alloc(32, 7).toString('base64url')
    await fs.writeFile(backupHeader, JSON.stringify(parsed), 'utf8')
    expect((await store.listBackups())[0]?.valid).toBe(false)

    const liveHeader = path.join(root, 'header.json')
    const live = JSON.parse(await fs.readFile(liveHeader, 'utf8'))
    live.keyCheck = Buffer.alloc(32, 9).toString('base64url')
    await fs.writeFile(liveHeader, JSON.stringify(live), 'utf8')
    await expect(store.verifyRecovery()).rejects.toBeDefined()
  }, 30_000)
})
