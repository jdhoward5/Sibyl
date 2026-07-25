# Encrypted portability and recovery

Status: implementation specification

Sibyl’s `.sibyl` format is the default way to move a conversation or a complete
private library between devices. It is an independently encrypted container,
not a copy of the live vault and not a plaintext archive.

## Cryptographic format

The outer JSON object contains only:

- `magic: "SIBYL_BUNDLE"` and `formatVersion: 1`;
- a fresh vault-format header with a random 256-bit master key wrapped by an
  Argon2id-derived recovery key;
- one padded AES-256-GCM record containing the payload.

Each export generates a new master key, vault ID, KDF salt, record-key salt, and
nonces. It never reuses or exports the live vault master key. The v1 bundle uses
the same Argon2id security floor, HKDF domain separation, AES-256-GCM
authentication, canonical base64url validation, and power-of-two size padding
specified in `VAULT_FORMAT.md`.

The cleartext envelope reveals that the file is a Sibyl bundle, its format and
KDF parameters, random identifiers, a padded ciphertext size, and filesystem
timestamps. It does not reveal conversation IDs, titles, character names,
message counts, model names, or other semantic metadata.

The decrypted v1 payload is schema-validated and contains:

- scope (`conversation` or `library`) and export time;
- conversations, frozen persona snapshots, cast, user character, premise,
  continuity state, directions, and conversation overrides;
- the relevant persona library records;
- portable settings without device paths or credentials;
- model references without local filesystem paths or model bytes.

Hugging Face tokens, OS/device unlock material, live-vault keys, model files,
voice files, logs, and release credentials are never included.

The header is designed to accept a decrypt-capable passkey slot once a native
platform provider is available. v1 exports always include recovery-passphrase
unlock, so a bundle remains recoverable after hardware replacement.

## Export and import behavior

Export encrypts the complete payload in memory before the save dialog result is
written. Sibyl writes only the final encrypted string; it creates no plaintext
archive or temporary file. Default filenames are generic and contain no
conversation title.

Import applies these steps:

1. limit the selected file to 96 MiB and decode strict UTF-8;
2. validate the outer version and cryptographic envelopes;
3. derive the recovery key and authenticate the payload;
4. schema-validate every setting, persona, conversation, and model reference;
5. resolve matching local models and clear unresolved model IDs;
6. remap colliding conversation and persona IDs through all nested references;
7. retain the decrypted result only in a five-minute in-memory preview session;
8. show a content-free preview with counts, unresolved models, and remappings;
9. after explicit confirmation, encrypt every imported record and make the
   complete batch visible with one authenticated vault-index swap.

Cancellation and expired previews discard the in-memory import. A failed staged
record or index write removes the new ciphertext and leaves the current
authenticated index unchanged. A protective encrypted snapshot is taken before
the commit.

Conversation bundles merge personas and conversations but do not change global
preferences. Full-library bundles restore portable preferences and merge
personas/conversations. They never replace this device’s model directory or
Hugging Face credential.

Markdown, JSON, and Text remain explicit plaintext escape hatches. Their UI
warns that both content and metadata will be readable wherever the user saves
them.

## Local recovery snapshots

The Settings view can retain 1, 3, 5, or 10 ciphertext-only generations. The
limit is itself encrypted in private settings. Lowering it takes effect on the
next snapshot. “Snapshot now” creates and authenticates a generation
immediately.

“Run recovery drill” performs no restore. It authenticates the current header,
index, and every indexed record, then independently authenticates every
retained snapshot. A real restore first protects the current generation as
another snapshot, copies verified ciphertext under fresh opaque filenames,
swaps the authenticated index, and reloads the app.

Recommended recovery drill:

1. create an encrypted full-library bundle with a unique recovery passphrase;
2. run the in-app recovery drill;
3. on a separate OS account or spare device, open the bundle and review the
   content-free preview;
4. import it into a disposable Sibyl vault;
5. verify several conversations and persona snapshots;
6. delete the disposable profile securely when finished.

## Operational plaintext and filesystem limits

Sibyl intentionally leaves these non-conversation resources operationally
plaintext:

- installed model and voice registries, including local paths and availability;
- downloaded GGUF and Piper files;
- application binaries, version, update feed state, and generic diagnostics;
- vault/bundle magic, cryptographic versions, random IDs, KDF parameters,
  record kinds, padded sizes, file counts, and filesystem timestamps;
- user-chosen filenames and any explicit Markdown, JSON, or Text exports.

No conversation text, title, persona field, user character, prompt, continuity
fact, direction, semantic logical ID, or exact private-record length is
intentionally persisted in plaintext by Sibyl. OS pagefiles, hibernation,
filesystem journals, snapshots, cloud backup clients, process dumps, malware
with access to an unlocked process, and secure-deletion behavior remain outside
the application’s portable guarantees. Whole-vault rollback is the explicit
offline limitation documented in `VAULT_FORMAT.md`.

