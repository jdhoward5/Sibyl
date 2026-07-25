import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { argon2id } from 'hash-wasm'

const VAULT_MAGIC = 'SIBYL_VAULT'
const RECORD_MAGIC = 'SIBYL_RECORD'
const FORMAT_VERSION = 1
const KEY_VERSION = 1
const MASTER_KEY_BYTES = 32
const VAULT_ID_BYTES = 16
const SLOT_ID_BYTES = 16
const KDF_SALT_BYTES = 16
const PASSKEY_PRF_BYTES = 32
const RECORD_SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const OPAQUE_ID_BYTES = 24
const MIN_PADDING_BUCKET = 4 * 1024
const MAX_PADDING_BUCKET = 64 * 1024 * 1024
const MAX_PASSPHRASE_BYTES = 1024
const MAX_ARGON2_MEMORY_KIB = 256 * 1024
const MAX_ARGON2_ITERATIONS = 10
const MAX_ARGON2_PARALLELISM = 8

export const MIN_ARGON2_MEMORY_KIB = 65_536
export const MIN_ARGON2_ITERATIONS = 3

export interface Argon2idParams {
  memoryKiB: number
  iterations: number
  parallelism: number
}

export const DEFAULT_ARGON2ID_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  memoryKiB: MIN_ARGON2_MEMORY_KIB,
  iterations: MIN_ARGON2_ITERATIONS,
  parallelism: 4
})

interface AeadBox {
  nonce: string
  ciphertext: string
  tag: string
}

export interface RecoveryPassphraseSlot {
  type: 'recovery-passphrase'
  id: string
  kdf: {
    algorithm: 'argon2id'
    version: 19
    memoryKiB: number
    iterations: number
    parallelism: number
    salt: string
  }
  wrap: AeadBox
}

export interface DeviceKeySlot {
  type: 'device'
  id: string
  provider: 'electron-safe-storage'
  wrappedKey: string
}

export interface PasskeyKeySlot {
  type: 'passkey'
  id: string
  provider: 'webauthn-prf'
  credentialId: string
  prfSalt: string
  wrap: AeadBox
}

export type VaultKeySlot =
  | RecoveryPassphraseSlot
  | DeviceKeySlot
  | PasskeyKeySlot

export interface VaultHeader {
  magic: typeof VAULT_MAGIC
  formatVersion: typeof FORMAT_VERSION
  vaultId: string
  keyVersion: typeof KEY_VERSION
  keyCheck: string
  keySlots: VaultKeySlot[]
}

export interface VaultRecordEnvelope {
  magic: typeof RECORD_MAGIC
  formatVersion: typeof FORMAT_VERSION
  vaultId: string
  keyVersion: typeof KEY_VERSION
  opaqueId: string
  keySalt: string
  nonce: string
  paddingBucket: number
  ciphertext: string
  tag: string
}

export type VaultErrorCode =
  | 'INVALID_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'WEAK_KDF'
  | 'UNLOCK_FAILED'
  | 'VAULT_LOCKED'
  | 'RECORD_MISMATCH'
  | 'RECORD_TAMPERED'
  | 'RECORD_TOO_LARGE'

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

function fail(code: VaultErrorCode, message: string): never {
  throw new VaultError(code, message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail('INVALID_FORMAT', `${label} contains unexpected or missing fields.`)
  }
}

function integer(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('INVALID_FORMAT', `${label} is outside its supported range.`)
  }
  return value as number
}

function text(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail('INVALID_FORMAT', `${label} is invalid.`)
  }
  return value
}

function b64url(value: Buffer): string {
  return value.toString('base64url')
}

function fromB64url(value: unknown, label: string, expectedBytes?: number): Buffer {
  const encoded = text(value, label, MAX_PADDING_BUCKET * 2)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('INVALID_FORMAT', `${label} is not canonical base64url.`)
  }
  const decoded = Buffer.from(encoded, 'base64url')
  if (b64url(decoded) !== encoded || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    fail('INVALID_FORMAT', `${label} has an invalid encoded length.`)
  }
  return decoded
}

function assertKind(kind: unknown): string {
  const value = text(kind, 'record kind', 32)
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
    fail('INVALID_FORMAT', 'Record kind is invalid.')
  }
  return value
}

function assertArgon2Params(
  memoryKiB: unknown,
  iterations: unknown,
  parallelism: unknown
): Argon2idParams {
  const parsed = {
    memoryKiB: integer(memoryKiB, 'Argon2 memory', 8, MAX_ARGON2_MEMORY_KIB),
    iterations: integer(iterations, 'Argon2 iterations', 1, MAX_ARGON2_ITERATIONS),
    parallelism: integer(parallelism, 'Argon2 parallelism', 1, MAX_ARGON2_PARALLELISM)
  }
  if (
    parsed.memoryKiB < MIN_ARGON2_MEMORY_KIB ||
    parsed.iterations < MIN_ARGON2_ITERATIONS
  ) {
    fail('WEAK_KDF', 'The vault uses Argon2 parameters below Sibyl’s security floor.')
  }
  return parsed
}

function parseAeadBox(value: unknown, label: string, expectedCiphertextBytes: number): AeadBox {
  if (!isObject(value)) fail('INVALID_FORMAT', `${label} is invalid.`)
  exactKeys(value, ['nonce', 'ciphertext', 'tag'], label)
  fromB64url(value.nonce, `${label} nonce`, NONCE_BYTES)
  fromB64url(value.ciphertext, `${label} ciphertext`, expectedCiphertextBytes)
  fromB64url(value.tag, `${label} tag`, TAG_BYTES)
  return {
    nonce: value.nonce as string,
    ciphertext: value.ciphertext as string,
    tag: value.tag as string
  }
}

function parseRecoverySlot(value: Record<string, unknown>): RecoveryPassphraseSlot {
  exactKeys(value, ['type', 'id', 'kdf', 'wrap'], 'recovery key slot')
  if (value.type !== 'recovery-passphrase') {
    fail('INVALID_FORMAT', 'Recovery key-slot type is invalid.')
  }
  fromB64url(value.id, 'key-slot id', SLOT_ID_BYTES)
  if (!isObject(value.kdf)) fail('INVALID_FORMAT', 'Recovery KDF is invalid.')
  exactKeys(
    value.kdf,
    ['algorithm', 'version', 'memoryKiB', 'iterations', 'parallelism', 'salt'],
    'recovery KDF'
  )
  if (value.kdf.algorithm !== 'argon2id' || value.kdf.version !== 19) {
    fail('UNSUPPORTED_VERSION', 'The recovery KDF is not supported.')
  }
  const params = assertArgon2Params(
    value.kdf.memoryKiB,
    value.kdf.iterations,
    value.kdf.parallelism
  )
  fromB64url(value.kdf.salt, 'recovery KDF salt', KDF_SALT_BYTES)
  return {
    type: 'recovery-passphrase',
    id: value.id as string,
    kdf: {
      algorithm: 'argon2id',
      version: 19,
      ...params,
      salt: value.kdf.salt as string
    },
    wrap: parseAeadBox(value.wrap, 'recovery key wrap', MASTER_KEY_BYTES)
  }
}

function parseDeviceSlot(value: Record<string, unknown>): DeviceKeySlot {
  exactKeys(value, ['type', 'id', 'provider', 'wrappedKey'], 'device key slot')
  if (value.type !== 'device' || value.provider !== 'electron-safe-storage') {
    fail('INVALID_FORMAT', 'Device key-slot provider is invalid.')
  }
  fromB64url(value.id, 'key-slot id', SLOT_ID_BYTES)
  fromB64url(value.wrappedKey, 'device-wrapped key')
  return {
    type: 'device',
    id: value.id as string,
    provider: 'electron-safe-storage',
    wrappedKey: value.wrappedKey as string
  }
}

function parsePasskeySlot(value: Record<string, unknown>): PasskeyKeySlot {
  exactKeys(
    value,
    ['type', 'id', 'provider', 'credentialId', 'prfSalt', 'wrap'],
    'passkey key slot'
  )
  if (value.type !== 'passkey' || value.provider !== 'webauthn-prf') {
    fail('INVALID_FORMAT', 'Passkey key-slot provider is invalid.')
  }
  fromB64url(value.id, 'key-slot id', SLOT_ID_BYTES)
  const credentialId = fromB64url(value.credentialId, 'passkey credential id')
  try {
    if (credentialId.length < 16 || credentialId.length > 1024) {
      fail('INVALID_FORMAT', 'Passkey credential id has an invalid length.')
    }
  } finally {
    credentialId.fill(0)
  }
  fromB64url(value.prfSalt, 'passkey PRF salt', PASSKEY_PRF_BYTES)
  return {
    type: 'passkey',
    id: value.id as string,
    provider: 'webauthn-prf',
    credentialId: value.credentialId as string,
    prfSalt: value.prfSalt as string,
    wrap: parseAeadBox(value.wrap, 'passkey key wrap', MASTER_KEY_BYTES)
  }
}

export function parseVaultHeader(value: unknown): VaultHeader {
  if (!isObject(value)) fail('INVALID_FORMAT', 'Vault header is invalid.')
  exactKeys(
    value,
    ['magic', 'formatVersion', 'vaultId', 'keyVersion', 'keyCheck', 'keySlots'],
    'vault header'
  )
  if (value.magic !== VAULT_MAGIC) fail('INVALID_FORMAT', 'Vault magic is invalid.')
  if (value.formatVersion !== FORMAT_VERSION || value.keyVersion !== KEY_VERSION) {
    fail('UNSUPPORTED_VERSION', 'This vault version is not supported.')
  }
  fromB64url(value.vaultId, 'vault id', VAULT_ID_BYTES)
  fromB64url(value.keyCheck, 'vault key check', 32)
  if (!Array.isArray(value.keySlots) || value.keySlots.length < 1 || value.keySlots.length > 8) {
    fail('INVALID_FORMAT', 'Vault key slots are invalid.')
  }
  const keySlots = value.keySlots.map((slot) => {
    if (!isObject(slot)) fail('INVALID_FORMAT', 'Vault key slot is invalid.')
    if (slot.type === 'recovery-passphrase') return parseRecoverySlot(slot)
    if (slot.type === 'device') return parseDeviceSlot(slot)
    if (slot.type === 'passkey') return parsePasskeySlot(slot)
    return fail('UNSUPPORTED_VERSION', 'Vault key-slot type is not supported.')
  })
  const ids = new Set(keySlots.map((slot) => slot.id))
  if (ids.size !== keySlots.length) fail('INVALID_FORMAT', 'Vault key-slot IDs must be unique.')
  if (keySlots.filter((slot) => slot.type === 'recovery-passphrase').length !== 1) {
    fail('INVALID_FORMAT', 'A vault must contain exactly one recovery key slot.')
  }
  if (keySlots.filter((slot) => slot.type === 'device').length > 1) {
    fail('INVALID_FORMAT', 'A vault cannot contain duplicate device key slots.')
  }
  if (keySlots.filter((slot) => slot.type === 'passkey').length > 1) {
    fail('INVALID_FORMAT', 'A vault cannot contain duplicate passkey key slots.')
  }
  return {
    magic: VAULT_MAGIC,
    formatVersion: FORMAT_VERSION,
    vaultId: value.vaultId as string,
    keyVersion: KEY_VERSION,
    keyCheck: value.keyCheck as string,
    keySlots
  }
}

export function parseVaultRecord(value: unknown): VaultRecordEnvelope {
  if (!isObject(value)) fail('INVALID_FORMAT', 'Vault record is invalid.')
  exactKeys(
    value,
    [
      'magic',
      'formatVersion',
      'vaultId',
      'keyVersion',
      'opaqueId',
      'keySalt',
      'nonce',
      'paddingBucket',
      'ciphertext',
      'tag'
    ],
    'vault record'
  )
  if (value.magic !== RECORD_MAGIC) fail('INVALID_FORMAT', 'Record magic is invalid.')
  if (value.formatVersion !== FORMAT_VERSION || value.keyVersion !== KEY_VERSION) {
    fail('UNSUPPORTED_VERSION', 'This record version is not supported.')
  }
  fromB64url(value.vaultId, 'record vault id', VAULT_ID_BYTES)
  fromB64url(value.opaqueId, 'opaque record id', OPAQUE_ID_BYTES)
  fromB64url(value.keySalt, 'record key salt', RECORD_SALT_BYTES)
  fromB64url(value.nonce, 'record nonce', NONCE_BYTES)
  const paddingBucket = integer(
    value.paddingBucket,
    'padding bucket',
    MIN_PADDING_BUCKET,
    MAX_PADDING_BUCKET
  )
  if ((paddingBucket & (paddingBucket - 1)) !== 0) {
    fail('INVALID_FORMAT', 'Padding bucket must be a power of two.')
  }
  fromB64url(value.ciphertext, 'record ciphertext', paddingBucket)
  fromB64url(value.tag, 'record tag', TAG_BYTES)
  return {
    magic: RECORD_MAGIC,
    formatVersion: FORMAT_VERSION,
    vaultId: value.vaultId as string,
    keyVersion: KEY_VERSION,
    opaqueId: value.opaqueId as string,
    keySalt: value.keySalt as string,
    nonce: value.nonce as string,
    paddingBucket,
    ciphertext: value.ciphertext as string,
    tag: value.tag as string
  }
}

function joinAad(parts: Array<string | number>): Buffer {
  return Buffer.from(parts.join('\0'), 'utf8')
}

function recoverySlotAad(
  header: Pick<VaultHeader, 'vaultId' | 'keyVersion'>,
  slot: Pick<RecoveryPassphraseSlot, 'id' | 'type' | 'kdf'>
): Buffer {
  return joinAad([
    'sibyl:vault-slot:v1',
    header.vaultId,
    slot.id,
    slot.type,
    header.keyVersion,
    slot.kdf.algorithm,
    slot.kdf.version,
    slot.kdf.memoryKiB,
    slot.kdf.iterations,
    slot.kdf.parallelism,
    slot.kdf.salt
  ])
}

function passkeySlotAad(
  header: Pick<VaultHeader, 'vaultId' | 'keyVersion'>,
  slot: Pick<
    PasskeyKeySlot,
    'id' | 'type' | 'provider' | 'credentialId' | 'prfSalt'
  >
): Buffer {
  return joinAad([
    'sibyl:vault-passkey-slot:v1',
    header.vaultId,
    slot.id,
    slot.type,
    slot.provider,
    header.keyVersion,
    slot.credentialId,
    slot.prfSalt
  ])
}

function passkeyWrapKey(
  prfOutput: Buffer,
  header: Pick<VaultHeader, 'vaultId' | 'keyVersion'>,
  slot: Pick<PasskeyKeySlot, 'id'>
): Buffer {
  if (prfOutput.length !== PASSKEY_PRF_BYTES) {
    fail('UNLOCK_FAILED', 'The passkey could not unlock this vault.')
  }
  const vaultSalt = fromB64url(header.vaultId, 'vault id', VAULT_ID_BYTES)
  try {
    return Buffer.from(
      hkdfSync(
        'sha256',
        prfOutput,
        vaultSalt,
        joinAad([
          'sibyl:vault-passkey-wrap-key:v1',
          header.vaultId,
          header.keyVersion,
          slot.id
        ]),
        MASTER_KEY_BYTES
      )
    )
  } finally {
    vaultSalt.fill(0)
  }
}

function computeKeyCheck(masterKey: Buffer, vaultId: string, keyVersion: number): Buffer {
  return createHmac('sha256', masterKey)
    .update(joinAad(['sibyl:vault-key-check:v1', vaultId, keyVersion]))
    .digest()
}

function matchesKeyCheck(
  masterKey: Buffer,
  header: Pick<VaultHeader, 'vaultId' | 'keyVersion' | 'keyCheck'>
): boolean {
  const actual = computeKeyCheck(masterKey, header.vaultId, header.keyVersion)
  const expected = fromB64url(header.keyCheck, 'vault key check', actual.length)
  try {
    return timingSafeEqual(actual, expected)
  } finally {
    actual.fill(0)
    expected.fill(0)
  }
}

function recordAad(record: Pick<
  VaultRecordEnvelope,
  'vaultId' | 'keyVersion' | 'opaqueId' | 'paddingBucket'
>, kind: string): Buffer {
  return joinAad([
    'sibyl:record:v1',
    record.vaultId,
    record.keyVersion,
    kind,
    record.opaqueId,
    record.paddingBucket
  ])
}

function encryptAead(key: Buffer, plaintext: Buffer, aad: Buffer): AeadBox {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    nonce: b64url(nonce),
    ciphertext: b64url(ciphertext),
    tag: b64url(tag)
  }
}

function decryptAead(key: Buffer, box: AeadBox, aad: Buffer): Buffer {
  const nonce = fromB64url(box.nonce, 'AEAD nonce', NONCE_BYTES)
  const ciphertext = fromB64url(box.ciphertext, 'AEAD ciphertext')
  const tag = fromB64url(box.tag, 'AEAD tag', TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function passphraseBytes(passphrase: string): Buffer {
  if (typeof passphrase !== 'string') fail('UNLOCK_FAILED', 'The vault could not be unlocked.')
  const encoded = Buffer.from(passphrase, 'utf8')
  if (encoded.length === 0 || encoded.length > MAX_PASSPHRASE_BYTES) {
    encoded.fill(0)
    fail('UNLOCK_FAILED', 'The vault could not be unlocked.')
  }
  return encoded
}

async function deriveRecoveryKey(
  passphrase: string,
  salt: Buffer,
  params: Argon2idParams
): Promise<Buffer> {
  const password = passphraseBytes(passphrase)
  try {
    const derived = await argon2id({
      password,
      salt,
      memorySize: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: 'binary'
    })
    const key = Buffer.from(derived)
    derived.fill(0)
    return key
  } finally {
    password.fill(0)
  }
}

function paddingBucketFor(frameBytes: number): number {
  if (frameBytes > MAX_PADDING_BUCKET) {
    fail('RECORD_TOO_LARGE', 'The private record is too large for this vault version.')
  }
  let bucket = MIN_PADDING_BUCKET
  while (bucket < frameBytes) bucket *= 2
  return bucket
}

function sameEncoded(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export class VaultKey {
  #key: Buffer | null

  private constructor(
    readonly vaultId: string,
    readonly keyVersion: number,
    key: Buffer
  ) {
    this.#key = Buffer.from(key)
  }

  static fromBytes(vaultId: string, keyVersion: number, key: Buffer): VaultKey {
    fromB64url(vaultId, 'vault id', VAULT_ID_BYTES)
    if (keyVersion !== KEY_VERSION || key.length !== MASTER_KEY_BYTES) {
      fail('INVALID_FORMAT', 'Vault key material is invalid.')
    }
    return new VaultKey(vaultId, keyVersion, key)
  }

  get destroyed(): boolean {
    return this.#key === null
  }

  destroy(): void {
    this.#key?.fill(0)
    this.#key = null
  }

  private key(): Buffer {
    if (!this.#key) fail('VAULT_LOCKED', 'The private vault is locked.')
    return this.#key
  }

  copyBytesForWrapping(): Buffer {
    return Buffer.from(this.key())
  }

  /** Authenticate that a parsed header describes this exact live master key. */
  assertHeaderMatches(input: VaultHeader | unknown): VaultHeader {
    const header = parseVaultHeader(input)
    if (
      header.vaultId !== this.vaultId ||
      header.keyVersion !== this.keyVersion ||
      !matchesKeyCheck(this.key(), header)
    ) {
      fail('RECORD_MISMATCH', 'The encrypted header does not match this vault key.')
    }
    return header
  }

  opaqueRecordId(kind: string, logicalId: string): string {
    const checkedKind = assertKind(kind)
    if (
      typeof logicalId !== 'string' ||
      logicalId.length === 0 ||
      Buffer.byteLength(logicalId, 'utf8') > 1024
    ) {
      fail('INVALID_FORMAT', 'Logical record id is invalid.')
    }
    const indexKey = Buffer.from(
      hkdfSync(
        'sha256',
        this.key(),
        fromB64url(this.vaultId, 'vault id', VAULT_ID_BYTES),
        Buffer.from('sibyl:index-key:v1', 'utf8'),
        32
      )
    )
    try {
      const digest = createHmac('sha256', indexKey)
        .update(checkedKind, 'utf8')
        .update('\0', 'utf8')
        .update(logicalId, 'utf8')
        .digest()
      return b64url(digest.subarray(0, OPAQUE_ID_BYTES))
    } finally {
      indexKey.fill(0)
    }
  }

  encrypt(kind: string, logicalId: string, plaintext: Uint8Array): VaultRecordEnvelope {
    const checkedKind = assertKind(kind)
    const opaqueId = this.opaqueRecordId(checkedKind, logicalId)
    const plain = Buffer.from(plaintext)
    const frameBytes = 4 + plain.length
    const paddingBucket = paddingBucketFor(frameBytes)
    const frame = randomBytes(paddingBucket)
    frame.writeUInt32BE(plain.length, 0)
    plain.copy(frame, 4)

    const keySalt = randomBytes(RECORD_SALT_BYTES)
    const record: VaultRecordEnvelope = {
      magic: RECORD_MAGIC,
      formatVersion: FORMAT_VERSION,
      vaultId: this.vaultId,
      keyVersion: KEY_VERSION,
      opaqueId,
      keySalt: b64url(keySalt),
      nonce: '',
      paddingBucket,
      ciphertext: '',
      tag: ''
    }
    const recordKey = Buffer.from(
      hkdfSync(
        'sha256',
        this.key(),
        keySalt,
        joinAad([
          'sibyl:record-key:v1',
          record.vaultId,
          record.keyVersion,
          checkedKind,
          record.opaqueId
        ]),
        32
      )
    )
    try {
      const box = encryptAead(recordKey, frame, recordAad(record, checkedKind))
      record.nonce = box.nonce
      record.ciphertext = box.ciphertext
      record.tag = box.tag
      return record
    } finally {
      plain.fill(0)
      frame.fill(0)
      recordKey.fill(0)
    }
  }

  decrypt(
    input: VaultRecordEnvelope | unknown,
    expectedKind: string,
    expectedLogicalId: string
  ): Buffer {
    const record = parseVaultRecord(input)
    const checkedKind = assertKind(expectedKind)
    const expectedOpaqueId = this.opaqueRecordId(checkedKind, expectedLogicalId)
    if (
      record.vaultId !== this.vaultId ||
      record.keyVersion !== this.keyVersion ||
      !sameEncoded(record.opaqueId, expectedOpaqueId)
    ) {
      fail('RECORD_MISMATCH', 'The encrypted record does not match the requested private data.')
    }
    const keySalt = fromB64url(record.keySalt, 'record key salt', RECORD_SALT_BYTES)
    const recordKey = Buffer.from(
      hkdfSync(
        'sha256',
        this.key(),
        keySalt,
        joinAad([
          'sibyl:record-key:v1',
          record.vaultId,
          record.keyVersion,
          checkedKind,
          record.opaqueId
        ]),
        32
      )
    )
    let frame: Buffer
    try {
      frame = decryptAead(recordKey, record, recordAad(record, checkedKind))
    } catch {
      fail('RECORD_TAMPERED', 'The encrypted private record failed authentication.')
    } finally {
      recordKey.fill(0)
    }
    try {
      if (frame.length !== record.paddingBucket || frame.length < 4) {
        fail('RECORD_TAMPERED', 'The encrypted private record has an invalid frame.')
      }
      const length = frame.readUInt32BE(0)
      if (length > frame.length - 4) {
        fail('RECORD_TAMPERED', 'The encrypted private record has an invalid length.')
      }
      return Buffer.from(frame.subarray(4, 4 + length))
    } finally {
      frame.fill(0)
    }
  }

  encryptJson(kind: string, logicalId: string, value: unknown): VaultRecordEnvelope {
    const json = Buffer.from(JSON.stringify(value), 'utf8')
    try {
      return this.encrypt(kind, logicalId, json)
    } finally {
      json.fill(0)
    }
  }

  decryptJson(
    input: VaultRecordEnvelope | unknown,
    expectedKind: string,
    expectedLogicalId: string
  ): unknown {
    const plaintext = this.decrypt(input, expectedKind, expectedLogicalId)
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      return JSON.parse(decoded) as unknown
    } catch {
      fail('RECORD_TAMPERED', 'The encrypted private record does not contain valid JSON.')
    } finally {
      plaintext.fill(0)
    }
  }
}

export async function createVault(
  recoveryPassphrase: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): Promise<{ header: VaultHeader; key: VaultKey }> {
  const checkedParams = assertArgon2Params(
    params.memoryKiB,
    params.iterations,
    params.parallelism
  )
  const masterKey = randomBytes(MASTER_KEY_BYTES)
  const vaultId = b64url(randomBytes(VAULT_ID_BYTES))
  const slotId = b64url(randomBytes(SLOT_ID_BYTES))
  const salt = randomBytes(KDF_SALT_BYTES)
  const headerBase: Pick<VaultHeader, 'vaultId' | 'keyVersion'> = {
    vaultId,
    keyVersion: KEY_VERSION
  }
  const slotBase: Omit<RecoveryPassphraseSlot, 'wrap'> = {
    id: slotId,
    type: 'recovery-passphrase',
    kdf: {
      algorithm: 'argon2id',
      version: 19,
      ...checkedParams,
      salt: b64url(salt)
    }
  }
  const recoveryKey = await deriveRecoveryKey(recoveryPassphrase, salt, checkedParams)
  try {
    const slot: RecoveryPassphraseSlot = {
      ...slotBase,
      wrap: encryptAead(recoveryKey, masterKey, recoverySlotAad(headerBase, slotBase))
    }
    const header: VaultHeader = {
      magic: VAULT_MAGIC,
      formatVersion: FORMAT_VERSION,
      vaultId,
      keyVersion: KEY_VERSION,
      keyCheck: b64url(computeKeyCheck(masterKey, vaultId, KEY_VERSION)),
      keySlots: [slot]
    }
    return { header, key: VaultKey.fromBytes(vaultId, KEY_VERSION, masterKey) }
  } finally {
    recoveryKey.fill(0)
    masterKey.fill(0)
  }
}

export async function unlockVaultWithPassphrase(
  input: VaultHeader | unknown,
  recoveryPassphrase: string
): Promise<VaultKey> {
  const header = parseVaultHeader(input)
  const slot = header.keySlots.find(
    (candidate): candidate is RecoveryPassphraseSlot =>
      candidate.type === 'recovery-passphrase'
  )
  if (!slot) fail('UNLOCK_FAILED', 'The vault could not be unlocked.')
  const salt = fromB64url(slot.kdf.salt, 'recovery KDF salt', KDF_SALT_BYTES)
  const params = assertArgon2Params(
    slot.kdf.memoryKiB,
    slot.kdf.iterations,
    slot.kdf.parallelism
  )
  const recoveryKey = await deriveRecoveryKey(recoveryPassphrase, salt, params)
  let masterKey: Buffer
  try {
    masterKey = decryptAead(recoveryKey, slot.wrap, recoverySlotAad(header, slot))
  } catch {
    fail('UNLOCK_FAILED', 'The vault could not be unlocked.')
  } finally {
    recoveryKey.fill(0)
  }
  try {
    if (masterKey.length !== MASTER_KEY_BYTES || !matchesKeyCheck(masterKey, header)) {
      fail('UNLOCK_FAILED', 'The vault could not be unlocked.')
    }
    return VaultKey.fromBytes(header.vaultId, header.keyVersion, masterKey)
  } finally {
    masterKey.fill(0)
  }
}

export async function addDeviceKeySlot(
  input: VaultHeader | unknown,
  key: VaultKey,
  protect: (masterKey: Buffer) => Promise<Buffer>
): Promise<VaultHeader> {
  const header = parseVaultHeader(input)
  if (header.vaultId !== key.vaultId || header.keyVersion !== key.keyVersion) {
    fail('RECORD_MISMATCH', 'The device key slot does not belong to this vault.')
  }
  const masterKey = key.copyBytesForWrapping()
  let wrapped: Buffer
  try {
    if (!matchesKeyCheck(masterKey, header)) {
      fail('RECORD_MISMATCH', 'The device key slot does not belong to this vault.')
    }
    wrapped = await protect(masterKey)
  } finally {
    masterKey.fill(0)
  }
  try {
    if (wrapped.length === 0 || wrapped.length > 16 * 1024) {
      fail('INVALID_FORMAT', 'The device key provider returned invalid data.')
    }
    const slot: DeviceKeySlot = {
      type: 'device',
      id: b64url(randomBytes(SLOT_ID_BYTES)),
      provider: 'electron-safe-storage',
      wrappedKey: b64url(wrapped)
    }
    return {
      ...header,
      keySlots: [...header.keySlots.filter((candidate) => candidate.type !== 'device'), slot]
    }
  } finally {
    wrapped.fill(0)
  }
}

export function addPasskeyKeySlot(
  input: VaultHeader | unknown,
  key: VaultKey,
  credentialId: Buffer,
  prfSalt: Buffer,
  prfOutput: Buffer
): VaultHeader {
  const header = parseVaultHeader(input)
  if (header.vaultId !== key.vaultId || header.keyVersion !== key.keyVersion) {
    fail('RECORD_MISMATCH', 'The passkey key slot does not belong to this vault.')
  }
  if (
    credentialId.length < 16 ||
    credentialId.length > 1024 ||
    prfSalt.length !== PASSKEY_PRF_BYTES ||
    prfOutput.length !== PASSKEY_PRF_BYTES
  ) {
    fail('INVALID_FORMAT', 'The passkey provider returned invalid data.')
  }
  const masterKey = key.copyBytesForWrapping()
  const slotBase: Omit<PasskeyKeySlot, 'wrap'> = {
    type: 'passkey',
    id: b64url(randomBytes(SLOT_ID_BYTES)),
    provider: 'webauthn-prf',
    credentialId: b64url(credentialId),
    prfSalt: b64url(prfSalt)
  }
  const wrappingKey = passkeyWrapKey(prfOutput, header, slotBase)
  try {
    if (!matchesKeyCheck(masterKey, header)) {
      fail('RECORD_MISMATCH', 'The passkey key slot does not belong to this vault.')
    }
    const slot: PasskeyKeySlot = {
      ...slotBase,
      wrap: encryptAead(
        wrappingKey,
        masterKey,
        passkeySlotAad(header, slotBase)
      )
    }
    return {
      ...header,
      keySlots: [
        ...header.keySlots.filter((candidate) => candidate.type !== 'passkey'),
        slot
      ]
    }
  } finally {
    masterKey.fill(0)
    wrappingKey.fill(0)
  }
}

export async function replaceRecoveryPassphraseSlot(
  input: VaultHeader | unknown,
  key: VaultKey,
  recoveryPassphrase: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): Promise<VaultHeader> {
  const header = parseVaultHeader(input)
  if (header.vaultId !== key.vaultId || header.keyVersion !== key.keyVersion) {
    fail('RECORD_MISMATCH', 'The recovery key slot does not belong to this vault.')
  }
  const checkedParams = assertArgon2Params(
    params.memoryKiB,
    params.iterations,
    params.parallelism
  )
  const slotBase: Omit<RecoveryPassphraseSlot, 'wrap'> = {
    type: 'recovery-passphrase',
    id: b64url(randomBytes(SLOT_ID_BYTES)),
    kdf: {
      algorithm: 'argon2id',
      version: 19,
      ...checkedParams,
      salt: b64url(randomBytes(KDF_SALT_BYTES))
    }
  }
  const salt = fromB64url(slotBase.kdf.salt, 'recovery KDF salt', KDF_SALT_BYTES)
  const recoveryKey = await deriveRecoveryKey(recoveryPassphrase, salt, checkedParams)
  let masterKey: Buffer | null = null
  try {
    masterKey = key.copyBytesForWrapping()
    if (!matchesKeyCheck(masterKey, header)) {
      fail('RECORD_MISMATCH', 'The recovery key slot does not belong to this vault.')
    }
    const slot: RecoveryPassphraseSlot = {
      ...slotBase,
      wrap: encryptAead(recoveryKey, masterKey, recoverySlotAad(header, slotBase))
    }
    return {
      ...header,
      keySlots: [
        ...header.keySlots.filter((candidate) => candidate.type !== 'recovery-passphrase'),
        slot
      ]
    }
  } finally {
    recoveryKey.fill(0)
    masterKey?.fill(0)
    salt.fill(0)
  }
}

export async function unlockVaultWithDevice(
  input: VaultHeader | unknown,
  unprotect: (wrappedKey: Buffer) => Promise<Buffer>
): Promise<VaultKey> {
  const header = parseVaultHeader(input)
  const slot = header.keySlots.find(
    (candidate): candidate is DeviceKeySlot => candidate.type === 'device'
  )
  if (!slot) fail('UNLOCK_FAILED', 'The vault could not be unlocked on this device.')
  const wrapped = fromB64url(slot.wrappedKey, 'device-wrapped key')
  let masterKey: Buffer
  try {
    masterKey = await unprotect(wrapped)
  } catch {
    fail('UNLOCK_FAILED', 'The vault could not be unlocked on this device.')
  } finally {
    wrapped.fill(0)
  }
  try {
    if (masterKey.length !== MASTER_KEY_BYTES || !matchesKeyCheck(masterKey, header)) {
      fail('UNLOCK_FAILED', 'The vault could not be unlocked on this device.')
    }
    return VaultKey.fromBytes(header.vaultId, header.keyVersion, masterKey)
  } finally {
    masterKey.fill(0)
  }
}

export async function unlockVaultWithPasskey(
  input: VaultHeader | unknown,
  evaluate: (credentialId: Buffer, salt: Buffer) => Promise<Buffer>
): Promise<VaultKey> {
  const header = parseVaultHeader(input)
  const slot = header.keySlots.find(
    (candidate): candidate is PasskeyKeySlot => candidate.type === 'passkey'
  )
  if (!slot) fail('UNLOCK_FAILED', 'The vault has no enrolled passkey.')
  const credentialId = fromB64url(
    slot.credentialId,
    'passkey credential id'
  )
  const salt = fromB64url(
    slot.prfSalt,
    'passkey PRF salt',
    PASSKEY_PRF_BYTES
  )
  let prfOutput: Buffer
  try {
    prfOutput = await evaluate(credentialId, salt)
  } catch {
    fail('UNLOCK_FAILED', 'The passkey could not unlock this vault.')
  } finally {
    credentialId.fill(0)
    salt.fill(0)
  }
  let wrappingKey: Buffer
  try {
    wrappingKey = passkeyWrapKey(prfOutput, header, slot)
  } finally {
    prfOutput.fill(0)
  }
  let masterKey: Buffer
  try {
    masterKey = decryptAead(
      wrappingKey,
      slot.wrap,
      passkeySlotAad(header, slot)
    )
  } catch {
    fail('UNLOCK_FAILED', 'The passkey could not unlock this vault.')
  } finally {
    wrappingKey.fill(0)
  }
  try {
    if (
      masterKey.length !== MASTER_KEY_BYTES ||
      !matchesKeyCheck(masterKey, header)
    ) {
      fail('UNLOCK_FAILED', 'The passkey could not unlock this vault.')
    }
    return VaultKey.fromBytes(header.vaultId, header.keyVersion, masterKey)
  } finally {
    masterKey.fill(0)
  }
}

export function serializeVaultHeader(header: VaultHeader): string {
  return `${JSON.stringify(parseVaultHeader(header), null, 2)}\n`
}

export function serializeVaultRecord(record: VaultRecordEnvelope): string {
  return `${JSON.stringify(parseVaultRecord(record))}\n`
}
