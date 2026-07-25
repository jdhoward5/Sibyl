// Keep the entrypoint deliberately tiny. Passkey PRF work runs in a separate
// Electron process before Sibyl's full main-process dependency graph is loaded.
// That helper has no preload, app renderer, model engine, or ordinary IPC.
export {}

if (process.argv.includes('--sibyl-passkey-helper')) {
  const { runPasskeyHelper } = await import('./passkeyHelper')
  runPasskeyHelper()
} else {
  await import('./appMain')
}
