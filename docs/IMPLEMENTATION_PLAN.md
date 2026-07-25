# Sibyl Remaining Improvements — Implementation Plan

This plan resolves the open decisions in `IMPROVEMENTS.md` and sequences the
remaining work so that new roleplay state is never added to an unsafe persistence
foundation.

Date: 2026-07-24

## Resolved product decisions

- Plan all remaining roadmap items, with the next two milestones specified at
  implementation depth and later milestones kept as bounded epics.
- A scene's existing character-brief override becomes a shared **Scene
  instruction**. It applies to every cast prompt. Generation overrides remain
  scene-wide; per-speaker scene overrides arrive with the richer persona schema.
- Narration failure pauses autoplay and offers Retry narration or Continue
  without speech. If speech is unavailable before Play begins, Sibyl warns once
  and continues text-only.
- Play runs six beats by default, waits 1.5 seconds between unnarrated beats, and
  stops after two consecutive empty, failed, or near-duplicate beats. The UI
  exposes remaining beat, elapsed-time, and token budgets.
- The first scene director is hybrid: deterministic safety and budget rules
  surround an optional decision pass using the already loaded model. Invalid
  decisions fall back to round-robin. No secondary model is required initially.
- Director notes default to next beat and whole cast, with explicit target and
  lifetime controls.
- Structured memory is refreshed every several beats and before compaction, with
  a manual refresh action. Persona and relationship changes remain scene-local
  until the user explicitly promotes them.
- The human sees private thoughts in a clearly marked omniscient/director view;
  other characters receive only knowledge available to them. A simple
  all-narration-is-public mode remains available for weaker models.
- Conversations snapshot persona identity. Library edits affect old
  conversations only through an explicit Refresh action; deletion keeps the
  snapshot and offers replace or detach.
- Authenticode, Apple Developer ID signing, and notarization are blocked because
  credentials are not available. Hashes, SBOMs, release manifests, update-feed
  verification, and reproducible-build checks remain in scope.

## Security decision: encrypted private-data vault

### Security boundary

Sibyl will never intentionally persist private application data as plaintext.
The encrypted scope includes:

- conversations, titles, message attribution, timestamps, summaries, and
  structured memory;
- personas, snapshots, relationships, secrets, prompts, greetings, scene
  premises, goals, directions, and the user's character;
- private generation overrides and any future knowledge graph;
- encrypted backups and portable Sibyl bundles.

Operational registries that contain no conversation or persona information may
remain outside the vault: installed model paths, installed voice paths, download
state, update state, and non-private UI preferences. The Hugging Face token
continues to use OS-protected storage and never enters renderer memory.

The only cleartext vault header fields are cryptographic necessities: magic,
format and cipher versions, random salts, KDF parameters, key-slot descriptors,
and opaque credential identifiers. They must contain no semantic user data.
Opaque filenames, an encrypted index, and coarse ciphertext padding prevent
direct disclosure of conversation names, IDs, exact lengths, or ordering.

Filesystem observers can still see that a vault exists, its coarse size, and
when files change. Completely hiding access timing and storage volume would
require an ORAM-like design and is outside the desktop threat model. This
limitation must be stated plainly in the privacy documentation.

No plaintext temporary files are permitted. Decrypted data exists only in
memory while the vault is unlocked. Sibyl already avoids content logging and
does not start a crash reporter; the threat model must also note that the OS
pagefile, hibernation image, third-party screen capture, and externally enabled
process dumps are outside application-level guarantees.

### Envelope encryption

Use a versioned, independently reviewed format rather than encrypting directly
with a user's passphrase:

1. Generate a random 256-bit vault master key.
2. Derive an independent record key for every write using HKDF-SHA-256, the
   master key, a fresh random salt, and authenticated record identity.
3. Encrypt and authenticate each record with AES-256-GCM, a fresh 96-bit nonce,
   and AAD covering the format version, record kind, opaque record identifier,
   and key version.
4. Store the encrypted index separately from encrypted records. Pad records to
   coarse size buckets before encryption.
5. Wrap the master key into one or more independent unlock slots. Rewrapping a
   slot does not require re-encrypting every record.

Use Node's maintained cryptographic primitives for AES-GCM, HKDF, random bytes,
and constant-time comparisons. Use Argon2id for passphrase-derived slots, with a
128-bit random salt, parameters recorded in the header, a minimum 64 MiB memory
cost, and a startup benchmark that targets an acceptable desktop unlock delay
without dropping below the reviewed floor. The selected Argon2 implementation
must have published test vectors, memory wiping where available, and packaged
Windows x64/macOS arm64 verification.

### Unlock slots and modes

Every vault has a recovery-passphrase slot before plaintext migration is
committed:

- **Device slot:** wraps the master key with Electron `safeStorage`. Windows
  uses the synchronous DPAPI provider because the asynchronous provider can
  impose a roughly 30-second initialization delay in packaged unsigned apps;
  macOS uses the asynchronous Keychain provider. Both stay in the main process.
  It provides seamless access for the same OS user/device, but must not be
  described as guaranteed TPM or Secure Enclave protection.
- **Recovery-passphrase slot:** derives a key-encryption key with Argon2id and
  wraps the master key with authenticated encryption. It is portable and is the
  required fallback after hardware replacement, OS-keychain loss, or copying a
  vault to another device.
- **Passkey slot:** uses the WebAuthn PRF extension to derive wrapping material,
  followed by HKDF domain separation and authenticated master-key wrapping.
  Enrollment is offered only after a real capability check proves that PRF
  output is available. A recovery passphrase remains required because passkey
  providers and authenticators do not uniformly support PRF.

Two user-visible policies sit on top of the slots:

- **Seamless on this device** (default): attempt the device slot first; prompt
  for the recovery passphrase or enrolled passkey when the device slot is absent
  or unavailable.
- **Require unlock when Sibyl opens** (optional): do not automatically unwrap
  with the device slot. Require the configured passphrase or passkey every app
  launch. Provide Lock now; when locked, abort private operations, stop TTS,
  clear main-process caches and key buffers, and destroy/recreate the private
  renderer document so conversation data is not retained in its heap.

Passkey support begins with a time-boxed platform spike. Standard WebAuthn
signatures alone cannot decrypt an offline vault; Sibyl needs the PRF extension
or a native platform adapter. The spike must verify a stable relying-party
origin in packaged Electron, Windows Hello behavior, Touch ID/macOS behavior,
synced credential recovery, hardware security keys, and unsigned-app
limitations. If Electron's renderer path cannot meet those requirements without
weakening navigation security, implement narrow main-process native adapters to
the Windows WebAuthn/CNG and macOS AuthenticationServices/Keychain APIs instead.

### Migration and recovery

Migration is explicit and crash-safe:

1. Inventory and validate the existing settings, personas, and conversations
   without logging their contents.
2. Require creation and confirmation of a recovery passphrase.
3. Create the encrypted vault alongside the old store using ciphertext-only
   temporary files.
4. Read it back, authenticate every record, and compare non-secret structural
   counts in memory.
5. Atomically switch a small non-secret store-version marker.
6. Remove the old plaintext files only after the encrypted store is durable.
7. Keep only encrypted recovery copies.

Secure erasure cannot be guaranteed on SSDs, copy-on-write filesystems,
snapshots, or backups. The migration UI and release notes must explain that
deleting legacy plaintext prevents normal access but cannot promise removal from
previous filesystem history. Fresh installs must never create the legacy
plaintext format.

## Delivery sequence

| Milestone | Roadmap items | Outcome |
| --- | --- | --- |
| 0. Encrypted foundation | G2, H4, H6 foundation | All private persisted state and backups are encrypted; packaged runtime is minimal and dependencies are deterministic. |
| 1. Reliable bounded scenes | C3, C4, D1, H1, H2 | Six-beat autoplay is narration-safe, prompt-consistent, bounded, observable, and well tested. |
| 2. Durable roleplay identity and memory | E4, E3, E2, E1, D3 | Scenes keep versioned personas, scoped knowledge, structured state, and scoped directions without privacy leaks. |
| 3. Local scene director | D2 | Optional hybrid direction chooses valid speakers and can continue, pause, or end within explicit budgets. |
| 4. Voice and accessibility | F1, F2 | Cast voices are distinct and core flows meet a documented keyboard/screen-reader baseline. |
| 5. Portability and model guidance | G1, G3, remaining G2 | Encrypted portable bundles, full recovery, and explainable local hardware-fit advice are available. |
| 6. Reproducible releases | H3, H5, remaining H6 | Both platforms produce verified artifacts with manifests, SBOMs, hashes, and collision-safe publishing. |

H1 and H2 are continuous verification tracks, not end-loaded testing projects.
Each milestone adds its own main-process, renderer-store, migration, privacy, and
Electron E2E coverage before the next milestone begins.

## Milestone 0 — Encrypted foundation

### 0.1 Threat model and format specification

- Write a versioned vault-format specification including byte layout, AAD,
  padding buckets, nonce/key derivation, key-slot encoding, maximum sizes,
  rollback behavior, and forward migration.
- Have a dedicated security review before implementation and again before
  enabling migration for existing users.
- Add published algorithm test vectors plus Sibyl golden vectors that can be
  decrypted independently of the application.

### 0.2 Vault core

- Add a main-process-only crypto module and `PrivateStore` abstraction.
- Keep private values out of shared renderer-facing settings until unlock.
- Implement authenticated reads, atomic ciphertext writes, encrypted index
  updates, per-resource queues, key rotation, and tamper/corruption distinction.
- Extend static privacy tests so private types cannot reach generic filesystem
  writers, console calls, or cleartext JSON serialization paths.

### 0.3 Unlock, lock, and key management

- Add narrow typed IPC for vault status, unlock, lock, change recovery
  passphrase, enroll/remove device, and enroll/remove passkey slots. Never return
  keys or passphrases to the renderer.
- Add the startup lock screen, first-run enrollment, recovery flow, Lock now,
  failed-attempt backoff, Caps Lock indication, and passphrase-strength guidance.
- Make unlock failures non-oracular: distinguish user-actionable conditions
  without revealing whether a guessed passphrase was close or which record
  failed.
- Zero key/passphrase buffers where runtimes permit and recreate the renderer on
  lock.

### 0.4 Store migration and encrypted backup

- Move personas, prompts, conversations, snapshots, memory, and semantic
  conversation metadata behind `PrivateStore`.
- Migrate existing installations with the verified two-store procedure above.
- Add rotating ciphertext-only backups, restore preview after unlock, quarantine
  for tampered files, and a never-overwrite-the-last-good-copy invariant.
- Simulate a new device by removing the device slot and prove recovery using only
  the copied vault plus recovery passphrase.

### 0.5 Passkey spike and implementation

- Prototype WebAuthn PRF in the packaged Windows and macOS applications without
  relaxing exact-navigation or IPC sender checks.
- Test Windows Hello/TPM-backed credentials, macOS Touch ID/passkeys, a roaming
  hardware key, a synced credential where supported, credential deletion, and
  hardware replacement.
- If the renderer route fails the security or compatibility bar, implement and
  isolate native platform adapters. Passkey enrollment stays hidden when no
  decrypt-capable PRF/provider exists.

### 0.6 Package and dependency foundation

- Replace project-root packaging with a generated runtime staging directory
  containing only `out`, a minimal production package manifest, production
  dependencies, icons/licenses, and the required native runtime outputs.
- Add an automated package inspector that rejects source, tests, maps, docs,
  scripts, patches, dot-directories, old releases, smoke models, credentials, or
  missing native backends. Assert expected artifact-size bands.
- Pin patch-coupled native dependencies exactly. Apply safe patch updates in
  isolated maintenance commits; keep `node-llama-cpp` patch rebasing and b9616
  replacement as a separate project.
- Enforce `npm audit --omit=dev` at zero and report the full audit without using
  `npm audit fix --force`.

### Exit criteria

- A filesystem scan during normal use, migration, backup, failure injection, and
  app restart finds no plaintext private field or plaintext temporary copy.
- Wrong keys, modified headers, truncated records, record replay inconsistent
  with the current encrypted index, and swapped record files fail closed without
  destroying the last good ciphertext. Whole-vault rollback remains an explicit
  offline threat-model limitation.
- Same-device seamless unlock, required-on-launch unlock, copied-vault recovery,
  lock-now memory clearing, and interrupted migration pass packaged E2E tests.
- The packaged application contains only the approved runtime allowlist.

## Milestone 1 — Reliable bounded scenes

### 1.1 Close C3 narration lifecycle

- Keep narration pending from before `tts.speak` until playback completion,
  explicit stop, or error.
- Schedule the next scene beat only after narration reaches a terminal state.
- Implement the pause/retry/continue-muted policy and user-visible state.
- Add renderer-store tests for slow first synthesis, missing voice, synthesis
  error, manual stop, conversation switch, and abort.

### 1.2 Close C4 prompt consistency

- Compute a canonical fingerprint of every warm-session input: resolved prompt,
  persona/snapshot version, user character, compaction boundary/summary, scene
  instruction, and any knowledge/state projection.
- Rebuild ordinary warm history when the fingerprint changes.
- Rename and implement Scene instruction in the settings drawer; keep
  scene-wide generation overrides effective and hide inapplicable thread-only
  controls.
- Add unit and packaged E2E tests proving that edits affect the very next turn.

### 1.3 Implement D1 bounded autonomy

- Persist scene-run policy separately from transcript: requested beats,
  remaining beats, delay, start/deadline, completion-token budget, stop reason,
  pause-after-current, and consecutive-output-health counters.
- Replace the unlimited timer with an explicit reducer/state machine.
- Use normalized text fingerprints to stop near-duplicates; stop empty or failed
  loops after two consecutive occurrences.
- Pause at context-compaction, memory-maintenance, deadline, token, and resource
  thresholds. Surface exact stop reasons and allow an intentional six-beat
  continuation.
- Ensure Pause prevents scheduling the next beat immediately while allowing the
  current inference/narration to finish; Stop aborts the scoped active operation.

### 1.4 Close H1/H2 gaps for this layer

- Retain existing lifecycle, registry, validation, downloader, deletion, abort,
  turn-state, and prospective-context tests.
- Add prompt-fingerprint, narration, bounded-run, repetition, stale-event,
  persistence-failure, and rapid Step/Play/speak/direct coverage.
- Expand packaged UI E2E rather than relying only on mocked renderer tests.

### Exit criteria

- A scene cannot run beyond the explicit budget or schedule a beat after Pause.
- Narration cannot overlap, and every failure has a visible recovery path.
- Persona/global/scene prompt changes affect the next ordinary turn or scene beat.
- All static gates, packaged UI E2E, and isolated GPU scene smoke pass.

## Milestone 2 — Durable roleplay identity and memory

Implement this as one schema program with forward-only migrations and encrypted
storage:

1. **E4 persona snapshots:** versioned minimal snapshots at creation; explicit
   refresh; deletion impact preview with keep, replace, or detach; cast validity
   based on resolvable snapshots.
2. **E3 richer personas:** public description, private motivations, secrets,
   behavioral constraints, speech guidance, relationships, scene-local
   overrides, and voice settings. Define and enforce prompt token budgets.
3. **E2 knowledge boundaries:** explicit public/private message segments,
   deterministic per-character observations and secrets, omniscient human view,
   public-only compatibility mode, and privacy-labelled export.
4. **E1 structured state:** validated roleplay state with provenance message IDs,
   user-authored/pinned facts, correction UI, scheduled maintenance, and prose
   recap generation for prompt efficiency.
5. **D3 scoped directions:** target, lifetime, consumed state, edit/disable/remove
   actions, and an active-direction panel. One-shot directions are marked
   consumed only after a durable successful beat.

Exit requires migration tests from every currently supported conversation shape,
deterministic prompt filtering tests for every speaker, compaction across
multiple passes, and proof that user-pinned facts are never silently replaced.

## Milestone 3 — Local scene director

- Define a strict validated result: `speakerId`, short private `intent`, and
  `action: continue | pause | end`.
- Run deterministic checks first: budget, cast validity, pending human
  participation, unresolved direction, repetition, context, and natural
  terminal state.
- Offer the loaded-model decision pass as an opt-in cost. Keep its prompt and
  result private, ephemeral by default, and excluded from transcript/export
  unless the user asks to inspect it.
- Serialize director and beat inference through the existing single-engine
  lifecycle; show the extra token/time cost.
- Fall back to round-robin on parse failure, unavailable resources, missing
  speaker, or timeout.

Exit requires adversarial structured-output tests, invalid-speaker rejection,
deterministic fallback, natural pause/end E2E, and budget accounting that
includes director inference.

## Milestone 4 — Voice and accessibility

### F1 character voices

- Resolve voice settings speaker override → scene default → global default.
- Carry the selected voice through typed TTS IPC without exposing text to logs.
- Serialize ONNX use while caching the most likely next voice within a bounded
  memory budget.
- Fall back visibly when a voice is missing; retain gapless narration and the C3
  pause policy.

### F2 accessibility

- Target WCAG 2.2 AA for core flows.
- Convert clickable rows to semantic controls/listboxes; expose hover actions on
  focus; connect every label, slider, toggle, status, and validation error.
- Add correct dialog semantics, initial focus, focus trap, Escape behavior,
  restoration, reduced motion, and live regions that do not read every streamed
  token.
- Add automated accessibility checks plus documented Windows Narrator and macOS
  VoiceOver passes before release.

## Milestone 5 — Portability and model guidance

### G1 portable bundles

- Define a versioned encrypted `.sibyl` bundle containing conversation, snapshot
  cast, user character, premise, state, settings, and portable model metadata.
- Use a bundle-specific random key with recovery-passphrase and optional
  passkey-PRF slots. Never reuse the live vault master key.
- Decrypt and schema-validate in memory, show a privacy-aware preview, remap
  collisions, and write only after confirmation.
- Keep Markdown/text/JSON plaintext export as an explicit user-directed escape
  hatch with a clear warning and no plaintext temporary file.

### Remaining G2

- Add full encrypted-library export, backup rotation controls, restore history,
  and recovery drills.
- Document exactly what remains operational plaintext and the filesystem-level
  leakage limits described in the threat model.

### G3 hardware/model fit advisor

- Estimate RAM, VRAM, context KV cost, offload, and headroom from local metadata
  and detected resources.
- Warn before clearly infeasible loads, show uncertainty, and always permit an
  override.
- Keep benchmarks local and distinguish estimates from measured results.

## Milestone 6 — Reproducible releases

### H3 reproducibility

- Build in a disposable clean staging checkout using `npm ci`.
- Verify lockfile hash, exact dependency versions, patch application, b9616
  source revision, native binary hashes, clean tree, and local/remote tag-to-HEAD
  equality.
- Smoke-test the packaged app, not only source output.
- Upload a second platform only when existing asset hashes match; never use
  unconditional clobber.
- Emit a signed artifact manifest containing commit, lockfile, toolchain,
  backend, SBOM, package inventory, and SHA-256 values.

### H5 provenance without platform credentials

- Publish CycloneDX or SPDX SBOMs, hashes, build manifests, and GitHub provenance.
- Add a project-specific offline release-manifest signing key and embed only its
  public verification key in the app; keep the private key outside the
  repository. This protects the update feed but does not replace OS code signing.
- Mark Authenticode, Developer ID signing, notarization, and any
  hardware-backed release credential policy as blocked until credentials exist.
- Continue showing the honest unsigned-build installation guidance.

### H6 maintenance

- Land safe patch updates with the full gate after each coherent group.
- Pin `node-llama-cpp` exactly while its patch is version-coupled.
- Rebase the patch, rebuild both CUDA and Metal backends, compare behavior and
  performance, and only then adopt a newer version/revision.
- Keep production audit enforcement and full-audit reporting in CI.

## Mandatory verification for every substantive milestone

- Runtime schema/migration tests and static privacy tests.
- Main-process and pure shared unit tests.
- Renderer-store state-machine tests.
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm audit --omit=dev`
- `npm run build`
- `npm run test:e2e`
- Isolated packaged Electron smoke.
- Windows NVIDIA GPU smoke for engine, scene, and shutdown changes.
- Apple Silicon smoke before a macOS artifact is published.
- `/review-fix` after each substantive code block and before milestone closure.

## Completion accounting

Every proposed roadmap item is assigned:

- C3, C4, D1, H1, H2 → Milestone 1
- E4, E3, E2, E1, D3 → Milestone 2
- D2 → Milestone 3
- F1, F2 → Milestone 4
- G1, G3 and remaining G2 → Milestone 5
- H3, H5 and remaining H6 → Milestone 6
- G2 vault foundation, H4, and H6 pinning/audit foundation → Milestone 0

The roadmap should be updated from `Proposed` to `Planned` when implementation
issues are cut from this document. A milestone is complete only when its
packaged verification and migration/rollback criteria pass; passing unit tests
alone is not sufficient.
