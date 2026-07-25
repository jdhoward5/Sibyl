# Offline passkey/PRF spike

Date: 2026-07-24

## Goal

Determine whether Sibyl can add a passkey slot that decrypts an offline vault
without exposing a vault-derived wrapping key to ordinary renderer code or
weakening the exact-origin/navigation policy.

Standard WebAuthn signatures are not sufficient: an offline encrypted vault
needs deterministic secret material from the WebAuthn PRF extension (backed by
the authenticator's `hmac-secret` capability).

## Windows packaged-app result

Electron 42.4.1 / Chromium 148 on Windows reports all of the following:

- `isSecureContext === true` for the packaged `file://` renderer;
- a user-verifying platform authenticator;
- a platform passkey authenticator;
- `extension:prf === true`; and
- `extension:hmacCreateSecret === true`.

An actual credential-creation attempt, tested with Chromium's virtual CTAP 2.1
authenticator so no real credential or user secret was created, fails before
authenticator access:

```text
SecurityError: Public-key credentials are only available to HTTPS origins with
valid certificates, HTTP localhost origins, or extension pages.
```

Capability advertisement alone is therefore not an enrollment check. Sibyl's
packaged `file://` origin cannot create the required credential.

## Rejected workarounds

- A localhost web server would share the `localhost` relying-party namespace
  with other local processes and adds a network listener to a previously local
  application.
- Moving PRF output from the renderer to main would make renderer compromise an
  offline key-extraction path and violates the narrow key-management boundary.
- Treating a normal WebAuthn signature as encryption material is
  cryptographically incorrect because signatures are intentionally randomized
  or otherwise not a stable secret.
- A custom Electron scheme is not one of Chromium's WebAuthn-approved relying
  party origins.

## Networkless HTTPS follow-up

Electron can intercept `https` only inside a dedicated, non-persistent session.
Sibyl now uses the reserved, non-resolving origin
`https://vault.sibyl.invalid/` in such a session:

- there is no localhost listener, DNS lookup, certificate, or outbound request;
- the document has `default-src 'none'`, no preload, Node integration, or app
  renderer;
- popups and post-load navigation are denied;
- the normal renderer remains on its exact `file://`/development origin and
  cannot access this session;
- the context runs in a purpose-built helper Electron process, before Sibyl's
  main dependency graph loads, and returns results only through a bounded
  in-memory Node IPC channel to the vault main process. PRF output is never
  written to stdout;
- each helper uses a fresh temporary Chromium profile, disables GPU
  acceleration, and is considered complete only after its IPC result is
  received and the helper process exits. The profile is then removed.

Chromium's virtual CTAP 2.1 authenticator completed credential creation and a
user-verified assertion at this origin with `prf`/`hmac-secret` enabled. The two
operations produced the same 32-byte PRF result. `npm run test:passkey`
repeats that exact create/assert test without creating a real credential.

## Implemented decision

Passkey enrollment is capability-gated. A lightweight helper first checks for a
user-verifying platform authenticator and Chromium PRF capability. Enrollment
then performs a real credential creation and assertion; the vault slot is
committed only if the authenticator actually returns a stable 32-byte PRF
result. Unsupported devices never show the setting.

The encrypted slot stores only an opaque credential ID, a random PRF input, and
an authenticated master-key wrap. PRF output is domain-separated with HKDF,
used in the helper/main process only, and zeroed where JavaScript buffers permit.
Unlock requires user verification by Windows Hello, Touch ID, or another
PRF-capable authenticator. A synced passkey can unlock a copied vault on new
hardware; credential deletion or loss falls back to the mandatory Argon2id
recovery passphrase.

The ordinary same-device slot still uses Electron safeStorage (DPAPI on Windows,
Keychain on macOS). It is seamless but is not described as guaranteed TPM or
Secure Enclave protection. Passkey user verification is a separate optional
control.

Real Windows Hello, Touch ID, roaming-key, synced-credential, deletion, and
hardware-replacement checks remain platform release gates. Runtime capability
failure is fail-closed, so an unverified platform does not expose enrollment.
