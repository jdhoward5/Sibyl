import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Native-feeling modal focus management for Electron drawers: initial focus,
 * Tab/Shift+Tab trapping, Escape close, and restoration to the opener.
 */
export function useDialogFocus<T extends HTMLElement>(
  onClose: () => void,
  active = true
): RefObject<T> {
  const dialogRef = useRef<T>(null)
  const closeRef = useRef(onClose)

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog) return

    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null
      )
    requestAnimationFrame(() => {
      const initial =
        dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
        focusables()[0] ??
        dialog
      initial.focus()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      requestAnimationFrame(() => previous?.focus())
    }
  }, [active])

  return dialogRef as RefObject<T>
}
