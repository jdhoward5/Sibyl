// Pure Electron boundary policy helpers. This module deliberately has no
// Node/Electron imports so URL decisions can be unit-tested outside Electron.

export type RendererUrlPolicy =
  | { kind: 'file'; exactUrl: string }
  | { kind: 'origin'; exactOrigin: string }

/** Build the development policy from the configured Vite renderer URL. */
export function developmentRendererPolicy(configuredUrl: string): RendererUrlPolicy {
  const url = new URL(configuredUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ELECTRON_RENDERER_URL must use HTTP(S).')
  }
  return { kind: 'origin', exactOrigin: url.origin }
}

/** True only for Sibyl's one packaged document or exact development origin. */
export function isAllowedRendererUrl(rawUrl: string, policy: RendererUrlPolicy): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (policy.kind === 'file') {
    return url.protocol === 'file:' && url.href === policy.exactUrl
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === policy.exactOrigin
  )
}

/** Only ordinary web links may leave Sibyl for the system browser. */
export function isExternalWebUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Pure half of main's IPC sender authentication, kept testable without Electron. */
export function isTrustedRendererFrame(
  frame: {
    senderDestroyed: boolean
    isMainFrame: boolean
    isTopFrame: boolean
    url: string
  },
  policy: RendererUrlPolicy
): boolean {
  return (
    !frame.senderDestroyed &&
    frame.isMainFrame &&
    frame.isTopFrame &&
    isAllowedRendererUrl(frame.url, policy)
  )
}
