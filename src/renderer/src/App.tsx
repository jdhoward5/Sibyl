import { useEffect } from 'react'
import { actions, useStore } from './store'
import { TitleBar } from './components/TitleBar'
import { Rail } from './components/Rail'
import { ChatView } from './components/chat/ChatView'
import { CharactersView } from './components/persona/CharactersView'
import { ModelsView } from './components/models/ModelsView'
import { SettingsView } from './components/settings/SettingsView'
import { DownloadsBar } from './components/common/DownloadsBar'
import { Toast } from './components/common/Toast'
import { VaultGate } from './components/VaultGate'

export default function App() {
  const ready = useStore((s) => s.ready)
  const vault = useStore((s) => s.vault)
  const view = useStore((s) => s.view)
  const turnPhase = useStore((s) => s.turnOperation.phase)
  const speakingMessageId = useStore((s) => s.speakingMessageId)
  const activity =
    speakingMessageId
      ? 'Speaking response.'
      : turnPhase === 'generating'
        ? 'Generating response.'
        : turnPhase === 'narration-pending'
          ? 'Preparing speech.'
          : turnPhase === 'narrating'
            ? 'Speaking response.'
            : turnPhase === 'failed'
              ? 'Response failed.'
              : ''

  useEffect(() => {
    void actions.init()
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-sibyl-bg text-sibyl-text">
      <TitleBar />
      {!ready ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          role="status"
          aria-label="Loading Sibyl"
        >
          <span aria-hidden className="h-3 w-3 animate-pulse-glow rounded-full bg-sibyl-accent" />
        </div>
      ) : vault?.state !== 'unlocked' ? (
        vault && <VaultGate status={vault} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Rail />
          <main className="flex min-w-0 flex-1 flex-col">
            {view === 'studio' ? (
              <ChatView />
            ) : view === 'characters' ? (
              <CharactersView />
            ) : view === 'models' ? (
              <ModelsView />
            ) : (
              <SettingsView />
            )}
          </main>
        </div>
      )}
      {vault?.state === 'unlocked' && <DownloadsBar />}
      <Toast />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {activity}
      </div>
    </div>
  )
}
