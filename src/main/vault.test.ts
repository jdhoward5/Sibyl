import { describe, expect, it } from 'vitest'
import { argon2id } from 'hash-wasm'
import {
  DEFAULT_ARGON2ID_PARAMS,
  VaultError,
  addDeviceKeySlot,
  addPasskeyKeySlot,
  createVault,
  parseVaultHeader,
  parseVaultRecord,
  replaceRecoveryPassphraseSlot,
  serializeVaultHeader,
  serializeVaultRecord,
  unlockVaultWithDevice,
  unlockVaultWithPasskey,
  unlockVaultWithPassphrase
} from './vault'

const passphrase = 'correct horse battery staple'

describe('Argon2id implementation', () => {
  it('matches an independently published Argon2id v1.3 vector', async () => {
    // Published by the lua-argon2 binding using the reference Argon2 library:
    // $argon2id$v=19$m=4096,t=3,p=1$c29tZXNhbHQ$qLml5cbqFAO6YxVHhrSBHP0UWdxrIxkNcM8aMX3blzU
    const output = await argon2id({
      password: 'password',
      salt: 'somesalt',
      memorySize: 4096,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex'
    })
    expect(output).toBe('a8b9a5e5c6ea1403ba63154786b4811cfd1459dc6b23190d70cf1a317ddb9735')
  })
})

describe('vault envelope encryption', () => {
  it('creates a strict header and unlocks with the recovery passphrase', async () => {
    const created = await createVault(passphrase)
    const parsed = parseVaultHeader(JSON.parse(serializeVaultHeader(created.header)))
    expect(parsed.magic).toBe('SIBYL_VAULT')
    expect(parsed.keySlots).toHaveLength(1)

    const unlocked = await unlockVaultWithPassphrase(parsed, passphrase)
    const record = unlocked.encryptJson('conversation', 'conv-1', {
      title: 'Invisible in the envelope',
      messages: [{ role: 'user', content: 'private words' }]
    })
    const serialized = serializeVaultRecord(record)
    expect(serialized).not.toContain('Invisible')
    expect(serialized).not.toContain('private words')
    expect(serialized).not.toContain('conv-1')
    expect(JSON.parse(serialized)).not.toHaveProperty('kind')
    expect(unlocked.decryptJson(JSON.parse(serialized), 'conversation', 'conv-1')).toEqual({
      title: 'Invisible in the envelope',
      messages: [{ role: 'user', content: 'private words' }]
    })

    created.key.destroy()
    unlocked.destroy()
  }, 30_000)

  it('uses stable opaque names but fresh ciphertext for each write', async () => {
    const { header, key } = await createVault(passphrase)
    const first = key.encryptJson('conversation', 'conv-1', { value: 'same' })
    const second = key.encryptJson('conversation', 'conv-1', { value: 'same' })
    expect(first.opaqueId).toBe(second.opaqueId)
    expect(first.keySalt).not.toBe(second.keySalt)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.paddingBucket).toBe(4096)
    expect(parseVaultHeader(header)).toEqual(header)
    key.destroy()
  }, 30_000)

  it('fails closed for wrong passphrases, tampering, swaps, and weak headers', async () => {
    const { header, key } = await createVault(passphrase)
    await expect(unlockVaultWithPassphrase(header, 'this is the wrong passphrase')).rejects.toMatchObject({
      code: 'UNLOCK_FAILED'
    })

    const record = key.encryptJson('conversation', 'conv-1', { secret: true })
    const tampered = {
      ...record,
      tag: `${record.tag[0] === 'A' ? 'B' : 'A'}${record.tag.slice(1)}`
    }
    expect(() => key.decryptJson(tampered, 'conversation', 'conv-1')).toThrow(VaultError)
    expect(() => key.decryptJson(record, 'conversation', 'conv-2')).toThrowError(
      expect.objectContaining({ code: 'RECORD_MISMATCH' })
    )

    const weak = structuredClone(header)
    const recovery = weak.keySlots.find((slot) => slot.type === 'recovery-passphrase')
    if (!recovery || recovery.type !== 'recovery-passphrase') throw new Error('missing test slot')
    recovery.kdf.memoryKiB = 1024
    expect(() => parseVaultHeader(weak)).toThrowError(expect.objectContaining({ code: 'WEAK_KDF' }))

    const unknown = { ...record, extra: true }
    expect(() => parseVaultRecord(unknown)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FORMAT' })
    )
    key.destroy()
  }, 30_000)

  it('supports an independent device-wrapped master-key slot', async () => {
    const { header, key } = await createVault(passphrase, DEFAULT_ARGON2ID_PARAMS)
    const deviceSecret = Buffer.alloc(32, 0x5a)
    const protect = async (master: Buffer): Promise<Buffer> => {
      const output = Buffer.alloc(master.length)
      for (let i = 0; i < master.length; i += 1) output[i] = master[i] ^ deviceSecret[i]
      return output
    }
    const withDevice = await addDeviceKeySlot(header, key, protect)
    expect(withDevice.keySlots.map((slot) => slot.type).sort()).toEqual([
      'device',
      'recovery-passphrase'
    ])
    const unlocked = await unlockVaultWithDevice(withDevice, protect)
    const record = unlocked.encryptJson('settings', 'main', { personas: ['private'] })
    expect(unlocked.decryptJson(record, 'settings', 'main')).toEqual({ personas: ['private'] })

    key.destroy()
    unlocked.destroy()
    deviceSecret.fill(0)
  }, 30_000)

  it('wraps the master key with deterministic passkey PRF output', async () => {
    const { header, key } = await createVault(passphrase)
    const credentialId = Buffer.alloc(32, 0x31)
    const prfSalt = Buffer.alloc(32, 0x42)
    const prfOutput = Buffer.alloc(32, 0x53)
    const withPasskey = addPasskeyKeySlot(
      header,
      key,
      credentialId,
      prfSalt,
      prfOutput
    )
    expect(withPasskey.keySlots.map((slot) => slot.type).sort()).toEqual([
      'passkey',
      'recovery-passphrase'
    ])
    const unlocked = await unlockVaultWithPasskey(
      withPasskey,
      async (receivedCredential, receivedSalt) => {
        expect(receivedCredential).toEqual(credentialId)
        expect(receivedSalt).toEqual(prfSalt)
        return Buffer.from(prfOutput)
      }
    )
    const record = unlocked.encryptJson('settings', 'main', {
      passkey: 'private'
    })
    expect(unlocked.decryptJson(record, 'settings', 'main')).toEqual({
      passkey: 'private'
    })
    await expect(
      unlockVaultWithPasskey(withPasskey, async () => Buffer.alloc(32, 0xff))
    ).rejects.toMatchObject({ code: 'UNLOCK_FAILED' })
    key.destroy()
    unlocked.destroy()
    credentialId.fill(0)
    prfSalt.fill(0)
    prfOutput.fill(0)
  }, 30_000)

  it('rotates the recovery passphrase without re-encrypting records', async () => {
    const { header, key } = await createVault(passphrase)
    const record = key.encryptJson('conversation', 'conv-1', { private: 'still readable' })
    const rotated = await replaceRecoveryPassphraseSlot(
      header,
      key,
      'a different recovery passphrase'
    )
    await expect(unlockVaultWithPassphrase(rotated, passphrase)).rejects.toMatchObject({
      code: 'UNLOCK_FAILED'
    })
    const unlocked = await unlockVaultWithPassphrase(
      rotated,
      'a different recovery passphrase'
    )
    expect(unlocked.decryptJson(record, 'conversation', 'conv-1')).toEqual({
      private: 'still readable'
    })
    key.destroy()
    unlocked.destroy()
  }, 30_000)

  it('rejects use after key destruction', async () => {
    const { key } = await createVault(passphrase)
    key.destroy()
    expect(() => key.encryptJson('settings', 'main', {})).toThrowError(
      expect.objectContaining({ code: 'VAULT_LOCKED' })
    )
  }, 30_000)
})
