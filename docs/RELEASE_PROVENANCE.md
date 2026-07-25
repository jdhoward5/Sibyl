# Release provenance and unsigned-platform status

Sibyl's Windows and macOS artifacts are **not platform-signed**. The project has
no Authenticode certificate, Apple Developer ID, notarization credential, or
hardware-backed release credential. Those controls remain blocked until their
credentials exist; the release scripts never imply otherwise.

As a result:

- Windows may show Microsoft Defender SmartScreen's **Unknown publisher**
  warning.
- macOS Gatekeeper may require **right-click → Open** on first launch. The
  alternative `xattr -dr com.apple.quarantine /Applications/Sibyl.app` removes
  quarantine for an installation the user has independently chosen to trust.
- The project Ed25519 signature authenticates release metadata. It is not an
  Authenticode signature, Apple code signature, or notarization ticket and
  cannot prove that a downloaded executable was untouched before first launch
  unless the user also verifies its signed manifest.

## Trust chain

`build/release-manifest-public.pem` is the only release key shipped in the
repository and app. Its private counterpart lives outside the repository at
`~/.sibyl-release/manifest-signing-key.pem` by default.

Each platform release publishes:

- `release-manifest-<platform>.json` and its detached Ed25519 `.sig`;
- a CycloneDX 1.6 production-dependency SBOM;
- a SHA-256 inventory of every packaged application file;
- `SHA256SUMS-<platform>` for artifacts and provenance files;
- GitHub artifact attestations linked to the repository workflow and release.

The manifest binds the source commit, commit timestamp, lockfile hash, exact
patch-coupled dependencies, patch names, Node/npm/Electron/electron-builder
toolchain, llama.cpp b9616 source tag, every custom native-runtime hash, SBOM,
package inventory, and distributable artifact hashes.

Before Windows invokes Squirrel, the installed app fetches the latest manifest,
signature, and `RELEASES`, verifies the Ed25519 signature using the embedded
public key, and requires the exact `RELEASES` hash named by the manifest.
Squirrel's own checksums then bind the `.nupkg`. Verification fails closed.

## One-time key setup

Run on the offline release machine:

```sh
node scripts/release-key.mjs --init
```

The command refuses to overwrite an existing key and prints only the public key.
Back up the private PEM in a separate encrypted offline location. Loss of the
key prevents signing new manifests trusted by already-installed apps; theft
allows forged project manifests. Never commit, upload, print, or place the
private PEM beneath the project tree.

Key rotation requires an application release that trusts both the old and new
public keys, signed by the old key, followed by a later release that removes the
old key. An emergency rotation after key loss cannot preserve automatic trust
for existing installs.

## Release procedure

The platform build host must have a clean checkout at the commit being released,
an authenticated `gh`, and the uncommitted custom b9616 native build beneath its
installed `node-llama-cpp`.

```sh
# Windows x64 GPU host
npm run release -- -DryRun
npm run release

# Apple Silicon Mac
npm run release:mac -- --dry-run
npm run release:mac
```

The release builder creates a disposable detached worktree, runs `npm ci`,
verifies dependencies, patches, native hashes, and any existing local/remote
version tag, runs all static/unit/Electron gates, builds in that worktree, and
launches the packaged application with an isolated user-data directory and
smoke model. It then signs provenance and copies the verified output into
`release/<version>`.

Publishing is collision-safe. A same-name GitHub asset is downloaded and
compared byte-for-byte. An exact match is retained; any mismatch aborts. The
scripts never use `--clobber`. Adding the second platform triggers the GitHub
provenance workflow again so those new assets receive attestations too.

`--skip-smoke` exists only for diagnostics and should not be used for a
published build. `--replace-output` explicitly replaces a local
`release/<version>` directory; it never changes a remote asset.

## Reproducibility scope

The process is reproducible in inputs, dependency installation, native-runtime
identity, and emitted provenance. DMG, ZIP, Squirrel, and Electron archives can
contain tool-generated ordering or timestamps, so byte-identical rebuilds are
not claimed. The signed package inventory makes differences observable and the
manifest records the commit-derived timestamp used for project metadata.
