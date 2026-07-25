import { useState } from 'react'
import type { PortableBundlePreview } from '@shared/portable'
import { actions } from '../store'
import { useDialogFocus } from '../lib/useDialogFocus'

interface ExportProps {
  conversationId?: string
  onClose: () => void
}

export function PortableExportDialog({ conversationId, onClose }: ExportProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose)
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const error =
    passphrase.length > 0 && passphrase.length < 12
      ? 'Use at least 12 characters.'
      : confirmation.length > 0 && confirmation !== passphrase
        ? 'The passphrases do not match.'
        : null
  const valid = passphrase.length >= 12 && passphrase === confirmation

  const save = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const saved = conversationId
      ? await actions.exportPortableConversation(conversationId, passphrase)
      : await actions.exportPortableLibrary(passphrase)
    setBusy(false)
    if (saved) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-export-title"
        className="w-full max-w-[500px] rounded-xl border border-sibyl-border bg-sibyl-panel p-5 shadow-2xl"
      >
        <h2 id="portable-export-title" className="font-mono text-[17px] font-bold text-sibyl-text">
          Export encrypted {conversationId ? 'conversation' : 'library'}
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-sibyl-muted">
          This creates a portable <span className="font-mono">.sibyl</span> file with
          its own random encryption key. The recovery passphrase is required on a
          different device and is not saved by Sibyl.
        </p>
        <div className="mt-4 grid gap-2">
          <label htmlFor="portable-export-passphrase" className="text-[12.5px] text-sibyl-text">
            Bundle recovery passphrase
          </label>
          <input
            id="portable-export-passphrase"
            autoFocus
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            className="input"
          />
          <label htmlFor="portable-export-confirmation" className="text-[12.5px] text-sibyl-text">
            Confirm passphrase
          </label>
          <input
            id="portable-export-confirmation"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            className="input"
            aria-describedby={error ? 'portable-export-error' : undefined}
          />
          {error && (
            <p id="portable-export-error" role="alert" className="text-[12px] text-red-300">
              {error}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => void save()}
            className="btn-primary disabled:opacity-40"
          >
            {busy ? 'Encrypting…' : 'Choose save location'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PortableImportDialog({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [preview, setPreview] = useState<PortableBundlePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    if (preview) void actions.discardPortableImport(preview.token)
    onClose()
  }
  const dialogRef = useDialogFocus<HTMLDivElement>(close)

  const inspect = async (): Promise<void> => {
    if (passphrase.length < 12 || busy) return
    setBusy(true)
    const next = await actions.inspectPortableImport(passphrase)
    setBusy(false)
    if (next) {
      setPreview(next)
      setPassphrase('')
    }
  }

  const commit = async (): Promise<void> => {
    if (!preview || busy) return
    setBusy(true)
    const imported = await actions.commitPortableImport(preview.token)
    setBusy(false)
    if (imported) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-import-title"
        className="w-full max-w-[520px] rounded-xl border border-sibyl-border bg-sibyl-panel p-5 shadow-2xl"
      >
        <h2 id="portable-import-title" className="font-mono text-[17px] font-bold text-sibyl-text">
          Import encrypted bundle
        </h2>
        {!preview ? (
          <>
            <p className="mt-2 text-[12.5px] leading-relaxed text-sibyl-muted">
              Sibyl decrypts and validates the selected file only in memory. Nothing
              is written until you review the content-free summary and confirm.
            </p>
            <label
              htmlFor="portable-import-passphrase"
              className="mt-4 block text-[12.5px] text-sibyl-text"
            >
              Bundle recovery passphrase
            </label>
            <input
              id="portable-import-passphrase"
              autoFocus
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void inspect()
              }}
              className="input mt-2"
            />
          </>
        ) : (
          <div className="mt-4 rounded-lg border border-sibyl-border/70 bg-sibyl-surface p-4">
            <p className="text-[13px] font-medium text-sibyl-text">
              Verified {preview.scope === 'library' ? 'library' : 'conversation'} bundle
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[12px]">
              <dt className="text-sibyl-muted">Conversations</dt>
              <dd className="text-right text-sibyl-text">{preview.conversationCount}</dd>
              <dt className="text-sibyl-muted">Personas</dt>
              <dd className="text-right text-sibyl-text">{preview.personaCount}</dd>
              <dt className="text-sibyl-muted">Model references</dt>
              <dd className="text-right text-sibyl-text">{preview.modelCount}</dd>
              <dt className="text-sibyl-muted">IDs remapped safely</dt>
              <dd className="text-right text-sibyl-text">{preview.collisionCount}</dd>
            </dl>
            {preview.unresolvedModelCount > 0 && (
              <p className="mt-3 text-[12px] leading-relaxed text-amber-300">
                {preview.unresolvedModelCount} model reference
                {preview.unresolvedModelCount === 1 ? '' : 's'} cannot be matched on
                this device. Those conversations import unloaded; you can choose a
                local model afterward.
              </p>
            )}
            <p className="mt-3 text-[11.5px] leading-relaxed text-sibyl-muted">
              This preview intentionally omits titles, character names, and message
              metadata. Confirming commits all imported private records atomically.
            </p>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={close} className="btn-ghost">
            Cancel
          </button>
          {preview ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void commit()}
              className="btn-primary disabled:opacity-40"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          ) : (
            <button
              type="button"
              disabled={passphrase.length < 12 || busy}
              onClick={() => void inspect()}
              className="btn-primary disabled:opacity-40"
            >
              {busy ? 'Opening…' : 'Choose encrypted bundle'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
