import { useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PrivateVaultStatus } from '@shared/types'
import { actions } from '../store'
import { SibylSigilIcon } from '../lib/icons'

interface Props {
  status: PrivateVaultStatus
}

export function VaultGate({ status }: Props) {
  const creating = status.state === 'uninitialized'
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [seamless, setSeamless] = useState(true)
  const [working, setWorking] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [capsLock, setCapsLock] = useState(false)

  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>): void => {
    setCapsLock(event.getModifierState('CapsLock'))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setLocalError(null)
    if (passphrase.length < 12) {
      setLocalError('Use at least 12 characters for your recovery passphrase.')
      return
    }
    if (creating && passphrase !== confirmation) {
      setLocalError('The recovery passphrases do not match.')
      return
    }
    setWorking(true)
    const accepted = creating
      ? await actions.setupVault(passphrase, seamless)
      : await actions.unlockVault(passphrase)
    setPassphrase('')
    setConfirmation('')
    if (!accepted) setWorking(false)
  }

  const unlockWithPasskey = async (): Promise<void> => {
    setLocalError(null)
    setWorking(true)
    const accepted = await actions.unlockVaultWithPasskey()
    if (!accepted) setWorking(false)
  }

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-md rounded-2xl border border-sibyl-border bg-sibyl-surface p-7 shadow-2xl"
      >
        <div className="mb-6">
          <div className="sigil-frame mb-4 h-12 w-12">
            <SibylSigilIcon size={27} />
          </div>
          <h1 className="text-xl font-semibold text-sibyl-text">
            {creating ? 'Protect your private data' : 'Unlock Sibyl'}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-sibyl-muted">
            {creating
              ? status.migrationRequired
                ? 'Your existing characters and conversations will be moved into an encrypted vault. The passphrase is required to recover them on another device.'
                : 'Sibyl stores characters and conversations in an encrypted vault. This passphrase recovers the vault after hardware or operating-system changes.'
              : 'Enter the recovery passphrase for this encrypted vault.'}
          </p>
        </div>

        {status.state === 'error' && status.error && (
          <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12.5px] text-red-300">
            {status.error}
          </div>
        )}

        {!creating && status.hasPasskeySlot && status.passkeyAvailable && (
          <>
            <button
              type="button"
              disabled={working}
              onClick={() => void unlockWithPasskey()}
              className="btn-primary mb-4 w-full justify-center py-2.5 text-[13px] disabled:opacity-50"
            >
              Unlock with passkey
            </button>
            <div className="mb-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-sibyl-border" />
              <span className="text-[11px] uppercase tracking-wider text-sibyl-muted">
                or use recovery
              </span>
              <span className="h-px flex-1 bg-sibyl-border" />
            </div>
          </>
        )}

        <label htmlFor="vault-passphrase" className="mb-1.5 block text-[13px] font-medium text-sibyl-text">
          Recovery passphrase
        </label>
        <input
          id="vault-passphrase"
          type="password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={updateCapsLock}
          onKeyUp={updateCapsLock}
          disabled={working}
          autoFocus
          className="input w-full text-[13px]"
        />
        {creating && (
          <>
            <label htmlFor="vault-passphrase-confirm" className="mb-1.5 mt-4 block text-[13px] font-medium text-sibyl-text">
              Confirm recovery passphrase
            </label>
            <input
              id="vault-passphrase-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              onKeyDown={updateCapsLock}
              onKeyUp={updateCapsLock}
              disabled={working}
              className="input w-full text-[13px]"
            />

            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-sibyl-border/70 p-3">
              <input
                type="checkbox"
                checked={seamless}
                onChange={(event) => setSeamless(event.target.checked)}
                disabled={working || !status.deviceStorageAvailable}
                className="mt-0.5 accent-[rgb(var(--accent))]"
              />
              <span>
                <span className="block text-[13px] font-medium text-sibyl-text">
                  Unlock seamlessly on this device
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-sibyl-muted">
                  Uses the operating-system keychain. Turn this off to require the passphrase whenever Sibyl opens.
                </span>
              </span>
            </label>
            {!status.deviceStorageAvailable && (
              <p className="mt-2 text-[11.5px] text-amber-300">
                Secure device storage is unavailable, so the passphrase will be required at launch.
              </p>
            )}
          </>
        )}

        {capsLock && (
          <p role="status" className="mt-3 text-[12px] text-amber-300">
            Caps Lock is on.
          </p>
        )}
        {creating && passphrase && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-sibyl-muted">
            {passphrase.length >= 20
              ? 'Good length. A unique multi-word passphrase is easiest to recover safely.'
              : 'Longer is stronger. Prefer several unique words and save them in a password manager.'}
          </p>
        )}

        {localError && (
          <p role="alert" className="mt-3 text-[12.5px] text-red-300">
            {localError}
          </p>
        )}

        <button
          type="submit"
          disabled={working}
          className="btn-primary mt-6 w-full justify-center py-2.5 text-[13px] disabled:opacity-50"
        >
          {working
            ? 'Working…'
            : creating
              ? 'Create encrypted vault'
              : status.state === 'error'
                ? 'Unlock and retry'
                : 'Unlock'}
        </button>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-sibyl-muted">
          Sibyl cannot recover a forgotten passphrase. Store it in a trusted password manager.
        </p>
      </form>
    </main>
  )
}
