# Sibyl Vault Format v1

Status: implementation specification

This document defines the first on-disk format for Sibyl private data. It is
deliberately narrow: cryptographic code in `src/main/vault.ts` is the reference
implementation, and every accepted input is runtime-validated before any
cryptographic operation.

## Threat model

The vault protects conversation and persona content plus semantic metadata from
an attacker who can read, copy, truncate, or replace files under Electron's
`userData` directory while Sibyl is not running. It detects ciphertext
modification, record swapping, wrong keys, and malformed or unsupported
versions. Once the encrypted index exists, it also detects replay of an
individual record that is inconsistent with that index.

The vault does not attempt to hide:

- that Sibyl has an encrypted vault;
- coarse ciphertext sizes and filesystem modification times;
- private data already present in OS pagefiles, hibernation images, external
  backups, snapshots, or process dumps outside Sibyl's control;
- data visible to a process that has compromised Sibyl while the vault is
  unlocked;
- rollback of the complete, internally consistent vault and header to an older
  snapshot. Preventing whole-vault rollback requires a trusted monotonic counter
  or remote anchor, neither of which is universally available offline.

Sibyl never intentionally writes a plaintext private record or plaintext
temporary file. Opaque names, an encrypted index, and size-bucket padding keep
conversation names, logical IDs, exact lengths, ordering, and timestamps out of
cleartext storage.

## Algorithms

- Master key: 32 random bytes from the operating-system CSPRNG.
- Passphrase KDF: Argon2id version 1.3, 32-byte output, 16-byte random salt.
- v1 KDF floor: 65,536 KiB, 3 iterations, at least one lane. New vaults use
  four lanes.
- Record key: HKDF-SHA-256 over the master key with a fresh 16-byte salt and
  domain-separated record information.
- Record encryption: AES-256-GCM with a fresh 12-byte nonce and 16-byte tag.
- Master-key wrapping: AES-256-GCM with a fresh 12-byte nonce and 16-byte tag.
- Opaque record name: HMAC-SHA-256 under a domain-separated index key, truncated
  to 24 bytes and base64url encoded.
- Binary encoding in JSON: unpadded canonical base64url.

Every record write uses a new HKDF salt, so a record key is never intentionally
reused. The random nonce remains mandatory. AAD authenticates every cleartext
field that controls interpretation.

## Header

`vault/header.json` is UTF-8 JSON:

```json
{
  "magic": "SIBYL_VAULT",
  "formatVersion": 1,
  "vaultId": "<16 bytes base64url>",
  "keyVersion": 1,
  "keyCheck": "<32 bytes base64url>",
  "keySlots": [
    {
      "type": "recovery-passphrase",
      "id": "<16 bytes base64url>",
      "kdf": {
        "algorithm": "argon2id",
        "version": 19,
        "memoryKiB": 65536,
        "iterations": 3,
        "parallelism": 4,
        "salt": "<16 bytes base64url>"
      },
      "wrap": {
        "nonce": "<12 bytes base64url>",
        "ciphertext": "<32 bytes base64url>",
        "tag": "<16 bytes base64url>"
      }
    }
  ]
}
```

`keyCheck` is HMAC-SHA-256 under the master key over a domain-separated vault
identity. It lets device-key unwrapping fail immediately when an OS provider
returns the wrong key; it contains no user data and does not make passphrase
guessing cheaper than the authenticated recovery-key wrap already does.

The header may also contain one device slot and one passkey slot. A v1 reader
rejects unknown fields, algorithms, slot types, weak KDF parameters, duplicate
slot IDs, duplicate slot types, or invalid lengths rather than guessing.

Recovery-slot AAD is the UTF-8 sequence:

```text
sibyl:vault-slot:v1\0<vaultId>\0<slotId>\0<slotType>\0<keyVersion>
\0<algorithm>\0<algorithmVersion>\0<memoryKiB>\0<iterations>
\0<parallelism>\0<salt>
```

No passphrase verifier is stored. Correctness is established only when
authenticated master-key unwrapping succeeds.

A passkey slot is:

```json
{
  "type": "passkey",
  "id": "<16 bytes base64url>",
  "provider": "webauthn-prf",
  "credentialId": "<16..1024 opaque bytes base64url>",
  "prfSalt": "<32 random bytes base64url>",
  "wrap": {
    "nonce": "<12 bytes base64url>",
    "ciphertext": "<32 bytes base64url>",
    "tag": "<16 bytes base64url>"
  }
}
```

The authenticator evaluates the stored PRF input for the selected credential
after user verification. Sibyl derives the 32-byte AES wrapping key with
HKDF-SHA-256 using the vault ID as salt and
`sibyl:vault-passkey-wrap-key:v1`, vault ID, key version, and slot ID as
domain-separated info. AEAD AAD is:

```text
sibyl:vault-passkey-slot:v1\0<vaultId>\0<slotId>\0passkey
\0webauthn-prf\0<keyVersion>\0<credentialId>\0<prfSalt>
```

Credential ID and PRF input are opaque non-secret routing material; PRF output
and the derived wrapping key are never serialized.

## Record envelope

One encrypted record is stored as UTF-8 JSON:

```json
{
  "magic": "SIBYL_RECORD",
  "formatVersion": 1,
  "vaultId": "<same vault ID>",
  "keyVersion": 1,
  "opaqueId": "<24 bytes base64url>",
  "keySalt": "<16 bytes base64url>",
  "nonce": "<12 bytes base64url>",
  "paddingBucket": 4096,
  "ciphertext": "<paddingBucket bytes base64url>",
  "tag": "<16 bytes base64url>"
}
```

Record kind is a lowercase ASCII identifier of at most 32 characters, but it is
not serialized in the envelope. It is known by the caller (or recovered from
the encrypted index) and remains bound into the record key and AAD. Logical
record IDs likewise never appear in the envelope or filename.

Record AAD is the UTF-8 sequence:

```text
sibyl:record:v1\0<vaultId>\0<keyVersion>\0<kind>\0<opaqueId>\0<paddingBucket>
```

Although `kind` is part of the authenticated interpretation above, it is not a
cleartext envelope field.

The decrypted padded frame is:

```text
uint32be plaintextLength
plaintextLength bytes plaintext
random padding to paddingBucket
```

Buckets are powers of two from 4 KiB through 64 MiB. The exact plaintext length
is authenticated inside the ciphertext and never stored in the envelope.

## Files and crash safety

The encrypted index maps logical IDs to opaque record names and contains all
semantic list metadata. Its logical record identity is fixed as `index/main`.
Private settings use `settings/main`; conversations use
`conversation/<conversation id>`.

Writes use a same-directory ciphertext-only temporary file, file flush, atomic
rename, and parent-directory flush where the platform supports it. The old
record is retained until the new ciphertext has been authenticated by a read
back. Backups copy only complete ciphertext envelopes and headers.

Related portable `.sibyl` bundles use a fresh independent master key and one
encrypted `portable-bundle/payload` record. Their payload, import transaction,
recovery drills, and operational-plaintext boundary are specified in
`PORTABLE_BUNDLES.md`.

## Versioning and rotation

`formatVersion` changes only for incompatible envelope interpretation.
`keyVersion` changes when record encryption migrates to a new master key. A
reader must not silently accept a version it does not implement.

Passphrase changes add and verify a new recovery slot, atomically replace the
header, and only then remove the old slot. Every authenticated retained recovery
generation receives the same current header before the operation completes; a
later successful unlock retries this synchronization after an interrupted
rotation. Device-slot and passkey-slot changes follow the same rule, so
app-managed snapshots do not retain an obsolete unlock credential. None of
these slot changes rewrite records. Full master-key rotation decrypts and
re-encrypts each record into a separate generation, verifies it, and atomically
swaps the encrypted index last.
