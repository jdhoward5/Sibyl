import { useState } from 'react'
import { actions, uid, useStore } from '../../store'
import type { AppSettings, GenerationProfile } from '@shared/types'
import { ACCENT_THEMES } from '@shared/themes'
import { TTS_VOICE_CATALOG } from '@shared/tts'
import { formatBytes } from '@shared/format'
import { Section, Slider, Toggle } from '../common/controls'
import { Avatar } from '../persona/Avatar'
import { PersonaEditor } from '../persona/PersonaEditor'
import {
  PlusIcon,
  TrashIcon,
  CheckIcon,
  EditIcon,
  DownloadIcon,
  SpeakerIcon,
  StopIcon,
  XIcon
} from '../../lib/icons'

/** Manage the persona library — the reusable characters you write with. */
function PersonasSection({ settings }: { settings: AppSettings }) {
  const personas = settings.personas
  const [editor, setEditor] = useState<{ id: string | null } | null>(null)
  return (
    <Section title="Personas" desc="Reusable characters: a name, a character brief, an opening line and sampling. Pick one when starting a thread.">
      {personas.length === 0 && <p className="text-[12.5px] text-sibyl-muted">No personas yet.</p>}
      {personas.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-lg border border-sibyl-border/60 px-3 py-2">
          <Avatar avatar={p.avatar} size={34} glow={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-sibyl-text">{p.name}</div>
            <div className="truncate text-[11px] text-sibyl-muted" title={p.brief}>
              {p.role || p.brief || 'No brief'}
            </div>
          </div>
          <button onClick={() => setEditor({ id: p.id })} className="btn-ghost shrink-0 px-2 py-1 text-[12px]" title="Edit">
            <EditIcon size={13} />
          </button>
          <button
            onClick={() => actions.deletePersona(p.id)}
            className="btn-ghost shrink-0 px-2 py-1 text-[12px] hover:text-red-300"
            title="Delete"
          >
            <TrashIcon size={13} />
          </button>
        </div>
      ))}
      <button onClick={() => setEditor({ id: null })} className="btn-surface w-full justify-center">
        <PlusIcon size={15} /> New persona
      </button>
      {editor && <PersonaEditor initialPersonaId={editor.id} onClose={() => setEditor(null)} />}
    </Section>
  )
}

/** Manage reusable generation-parameter profiles; apply one to the global params. */
function GenerationProfilesSection({ settings }: { settings: AppSettings }) {
  const profiles = settings.generationProfiles
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const save = (next: GenerationProfile[]): void =>
    void actions.updateSettings({ generationProfiles: next })

  const add = (): void => {
    const n = name.trim()
    if (!n) return
    save([...profiles, { id: uid(), name: n, options: { ...settings.generation } }])
    setName('')
  }

  return (
    <Section
      title="Generation profiles"
      desc="Named sampling presets. Apply one to the global parameters, or per-conversation."
    >
      {profiles.map((p) => (
        <div key={p.id} className="flex items-center gap-2 rounded-lg border border-sibyl-border/60 px-3 py-2">
          {editingId === p.id ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                save(profiles.map((x) => (x.id === p.id ? { ...x, name: draftName.trim() || x.name } : x)))
                setEditingId(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                else if (e.key === 'Escape') setEditingId(null)
              }}
              className="input h-7 flex-1 px-2 py-0 text-[13px]"
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-sibyl-text">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-sibyl-muted">
                temp {p.options.temperature} · top-p {p.options.topP} · {p.options.maxTokens} tok
              </div>
            </div>
          )}
          <button
            onClick={() =>
              actions.updateSettings({
                generation: { ...p.options, stopSequences: settings.generation.stopSequences }
              })
            }
            className="btn-surface shrink-0 px-2.5 py-1 text-[12px]"
            title="Apply to the global generation settings"
          >
            Apply
          </button>
          <button
            onClick={() => save(profiles.map((x) => (x.id === p.id ? { ...x, options: { ...settings.generation } } : x)))}
            className="btn-ghost shrink-0 px-2 py-1 text-[12px]"
            title="Update this profile to the current generation settings"
          >
            <CheckIcon size={13} />
          </button>
          <button
            onClick={() => {
              setEditingId(p.id)
              setDraftName(p.name)
            }}
            className="btn-ghost shrink-0 px-2 py-1 text-[12px]"
            title="Rename"
          >
            <EditIcon size={13} />
          </button>
          <button
            onClick={() => save(profiles.filter((x) => x.id !== p.id))}
            className="btn-ghost shrink-0 px-2 py-1 text-[12px] hover:text-red-300"
            title="Delete"
          >
            <TrashIcon size={13} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Name a new profile from the current settings…"
          className="input flex-1"
        />
        <button onClick={add} disabled={!name.trim()} className="btn-primary disabled:opacity-40">
          <PlusIcon size={15} /> Save
        </button>
      </div>
    </Section>
  )
}

/** Manage on-device speech: voices to download, selection, and playback controls. */
function VoiceSpeechSection({ settings }: { settings: AppSettings }) {
  const tts = settings.tts
  const status = useStore((s) => s.tts)
  const installed = useStore((s) => s.installedVoices)
  const downloads = useStore((s) => s.voiceDownloads)
  const speaking = useStore((s) => s.speakingMessageId)
  const available = status?.available ?? false
  const installedIds = new Set(installed.map((v) => v.id))

  return (
    <Section
      title="Voice & speech"
      desc="Read AI responses aloud with on-device neural voices (Piper). Voices download from Hugging Face and run locally — no audio ever leaves your machine."
    >
      {!available && (
        <p className="text-[12px] text-amber-400/90">
          {status?.error ?? 'On-device speech is unavailable in this build.'}
        </p>
      )}

      <Toggle
        label="Enable speech"
        desc="Show a “Speak” control on assistant replies."
        checked={tts.enabled}
        onChange={(v) => actions.updateTtsSettings({ enabled: v })}
      />

      <div className="flex flex-col gap-2">
        <label className="text-[13px] text-sibyl-text">Voices</label>
        {TTS_VOICE_CATALOG.map((v) => {
          const isInstalled = installedIds.has(v.id)
          const dl = downloads[v.id]
          const isActive = tts.voiceId === v.id && isInstalled
          const pct = dl && dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : 0
          return (
            <div
              key={v.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                isActive ? 'border-sibyl-accent/60 bg-sibyl-accent/10' : 'border-sibyl-border/60'
              }`}
            >
              <button
                onClick={() => isInstalled && actions.updateTtsSettings({ voiceId: v.id, enabled: true })}
                disabled={!isInstalled}
                title={isInstalled ? 'Use this voice' : 'Download to use'}
                className="shrink-0 disabled:cursor-not-allowed"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                    isActive ? 'border-sibyl-accent bg-sibyl-accent' : 'border-sibyl-border'
                  }`}
                >
                  {isActive && <CheckIcon size={10} className="text-sibyl-bg" />}
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-sibyl-text">{v.name}</div>
                <div className="truncate text-[11px] text-sibyl-muted">
                  {v.language} · {v.quality} · {formatBytes(v.sizeBytes)}
                </div>
              </div>
              {dl ? (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[11px] text-sibyl-accent">{pct}%</span>
                  <button
                    onClick={() => actions.cancelVoiceDownload(v.id)}
                    className="btn-ghost px-2 py-1 text-[12px]"
                    title="Cancel download"
                  >
                    <XIcon size={13} />
                  </button>
                </div>
              ) : isInstalled ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void actions.testVoice(v.id)}
                    className="btn-ghost px-2 py-1 text-[12px]"
                    title="Play a sample"
                  >
                    <SpeakerIcon size={14} />
                  </button>
                  <button
                    onClick={() => void actions.deleteVoice(v.id)}
                    className="btn-ghost px-2 py-1 text-[12px] hover:text-red-300"
                    title="Remove voice"
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => actions.downloadVoice(v.id)}
                  disabled={!available}
                  className="btn-surface shrink-0 px-2.5 py-1 text-[12px] disabled:opacity-40"
                  title={available ? 'Download this voice' : 'Speech is unavailable'}
                >
                  <DownloadIcon size={13} /> Download
                </button>
              )}
            </div>
          )
        })}
        {installed.length === 0 && (
          <p className="text-[12px] text-sibyl-muted">
            Download a voice to start — the medium voices (~{formatBytes(63 * 1024 * 1024)}) offer the best
            quality.
          </p>
        )}
      </div>

      <Toggle
        label="Auto-speak replies"
        desc="Read each new reply aloud as soon as it finishes generating."
        checked={tts.autoSpeak}
        onChange={(v) => actions.updateTtsSettings({ autoSpeak: v })}
      />
      <Slider
        label="Speaking rate"
        value={tts.rate}
        min={0.5}
        max={2}
        step={0.05}
        onChange={(v) => actions.updateTtsSettings({ rate: v })}
        format={(v) => `${v.toFixed(2)}×`}
      />
      <Slider
        label="Volume"
        value={tts.volume}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => actions.updateTtsSettings({ volume: v })}
        format={(v) => `${Math.round(v * 100)}%`}
      />

      {speaking && (
        <button onClick={() => actions.stopSpeaking()} className="btn-surface w-full justify-center">
          <StopIcon size={14} /> Stop speaking
        </button>
      )}
    </Section>
  )
}

/** Check for and apply app updates (Squirrel side-by-side, served from GitHub). */
function UpdatesSection() {
  const update = useStore((s) => s.update)
  const appInfo = useStore((s) => s.appInfo)
  const currentVersion = update?.currentVersion ?? appInfo?.version ?? '—'
  const state = update?.state ?? 'idle'
  // 'available' and 'downloading' are the same transient stage now — Squirrel
  // auto-downloads as soon as it finds an update, with no progress to show.
  const fetching = state === 'checking' || state === 'available' || state === 'downloading'
  // No in-app updater on this platform (the unsigned macOS build): there's
  // nothing to check, so hide the button and point at a manual download instead.
  const noUpdater = state === 'unsupported'

  return (
    <Section
      title="Updates"
      desc={
        noUpdater
          ? 'Update by downloading the latest release.'
          : 'Sibyl checks GitHub for new releases on launch and downloads them automatically.'
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-sibyl-text">Current version</p>
          <p className="font-mono text-[11px] text-sibyl-muted">{currentVersion}</p>
        </div>
        {state !== 'downloaded' && !noUpdater && (
          <button
            onClick={() => void actions.checkForUpdate()}
            disabled={fetching}
            className="btn-surface shrink-0 px-3 py-1.5 text-[13px] disabled:opacity-40"
          >
            {state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {noUpdater && (
          <a
            href="https://github.com/jdhoward5/Sibyl/releases/latest"
            target="_blank"
            rel="noreferrer"
            className="btn-surface shrink-0 px-3 py-1.5 text-[13px]"
          >
            View latest release
          </a>
        )}
      </div>

      {state === 'not-available' && (
        <p className="text-[12.5px] text-sibyl-muted">You’re running the latest version.</p>
      )}

      {noUpdater && (
        <p className="text-[12.5px] text-sibyl-muted">
          Automatic updates aren’t available in this build. Download the newest version from the
          releases page when one is published.
        </p>
      )}

      {state === 'dev-disabled' && (
        <p className="text-[12.5px] text-sibyl-muted">Updates are only available in the installed app.</p>
      )}

      {state === 'error' && (
        <p className="text-[12.5px] text-red-300">{update?.error ?? 'Update check failed.'}</p>
      )}

      {(state === 'available' || state === 'downloading') && (
        <p className="text-[12.5px] text-sibyl-muted">Downloading the latest update…</p>
      )}

      {state === 'downloaded' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-sibyl-accent/40 bg-sibyl-accent/10 px-3 py-2.5">
          <p className="text-[13px] text-sibyl-text">
            {update?.version ? (
              <>
                <span className="font-mono text-sibyl-glow">{update.version}</span> is ready.
              </>
            ) : (
              'An update is ready.'
            )}
          </p>
          <button onClick={() => void actions.installUpdate()} className="btn-primary shrink-0 px-3 py-1.5 text-[13px]">
            Restart &amp; install
          </button>
        </div>
      )}
    </Section>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const appInfo = useStore((s) => s.appInfo)
  const engine = useStore((s) => s.engine)
  const [token, setToken] = useState('')
  const [tokenDirty, setTokenDirty] = useState(false)

  if (!settings) return null

  const update = (patch: Partial<AppSettings>): void => void actions.updateSettings(patch)
  const gen = settings.generation
  const load = settings.load
  const ctx = settings.context

  // Offer only the backends that exist on the current OS: Metal on macOS,
  // CUDA/Vulkan on Windows. 'Auto' and 'CPU' are always valid.
  const isMac = appInfo?.platform === 'darwin'
  const gpuOptions: { value: AppSettings['gpu']; label: string }[] = isMac
    ? [
        { value: 'auto', label: 'Auto' },
        { value: 'metal', label: 'Metal' },
        { value: 'cpu', label: 'CPU' }
      ]
    : [
        { value: 'auto', label: 'Auto' },
        { value: 'cuda', label: 'CUDA' },
        { value: 'vulkan', label: 'Vulkan' },
        { value: 'cpu', label: 'CPU' }
      ]

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-8 py-7">
        <div className="eyebrow mb-2 text-sibyl-accent">// Settings</div>
        <h1 className="mb-6 font-mono text-[24px] font-extrabold text-sibyl-text">Preferences</h1>
        <div className="flex flex-col gap-4">
          <Section title="Inference backend" desc="How models are accelerated. Changes apply when you next load a model.">
            <div className="flex gap-2">
              {gpuOptions.map((o) => (
                <button
                  key={o.value}
                  onClick={() => update({ gpu: o.value })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
                    settings.gpu === o.value
                      ? 'border-sibyl-accent/60 bg-sibyl-accent/15 text-sibyl-text'
                      : 'border-sibyl-border text-sibyl-muted hover:text-sibyl-text'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {engine.gpuType && (
              <p className="text-[12px] text-sibyl-muted">
                Active backend:{' '}
                <span className="text-sibyl-glow">{String(engine.gpuType).toUpperCase()}</span>
              </p>
            )}
          </Section>

          <Section title="Model loading">
            <Slider
              label="Context window"
              value={load.contextSize}
              min={2048}
              max={32768}
              step={2048}
              onChange={(v) => update({ load: { ...load, contextSize: v } })}
              format={(v) => `${(v / 1024).toFixed(0)}K tokens`}
            />
            <Slider
              label="GPU layers"
              value={load.gpuLayers}
              min={-1}
              max={100}
              step={1}
              onChange={(v) => update({ load: { ...load, gpuLayers: v } })}
              format={(v) => (v < 0 ? 'Auto (max)' : String(v))}
            />
            <div>
              <label className="mb-1.5 block text-[13px] text-sibyl-text">Character brief</label>
              <p className="mb-1.5 text-[12px] text-sibyl-muted">
                The default system prompt for blank threads. Personas override this per thread.
              </p>
              <textarea
                value={load.systemPrompt}
                onChange={(e) => update({ load: { ...load, systemPrompt: e.target.value } })}
                rows={3}
                className="input resize-none"
              />
            </div>
          </Section>

          <Section
            title="Context management"
            desc="How Sibyl keeps long chats inside the model's context window."
          >
            <Toggle
              label="Auto-compact"
              desc="Summarize older turns automatically when the window is about to overflow."
              checked={ctx.autoCompact}
              onChange={(v) => update({ context: { ...ctx, autoCompact: v } })}
            />
            <Slider
              label="Auto-compact threshold"
              value={ctx.compactThreshold}
              min={0.5}
              max={0.98}
              step={0.01}
              onChange={(v) => update({ context: { ...ctx, compactThreshold: v } })}
              format={(v) => `${Math.round(v * 100)}% full`}
            />
            <Slider
              label="Warning threshold"
              value={ctx.warnThreshold}
              min={0.4}
              max={0.95}
              step={0.01}
              onChange={(v) => update({ context: { ...ctx, warnThreshold: v } })}
              format={(v) => `${Math.round(v * 100)}% full`}
            />
            <Slider
              label="Keep recent messages"
              value={ctx.keepRecentMessages}
              min={2}
              max={20}
              step={1}
              onChange={(v) => update({ context: { ...ctx, keepRecentMessages: v } })}
              format={(v) => `${v} messages`}
            />
          </Section>

          <Section title="Generation" desc="Sampling parameters for responses.">
            <Slider label="Temperature" value={gen.temperature} min={0} max={2} step={0.05}
              onChange={(v) => update({ generation: { ...gen, temperature: v } })} format={(v) => v.toFixed(2)} />
            <Slider label="Top-P" value={gen.topP} min={0} max={1} step={0.01}
              onChange={(v) => update({ generation: { ...gen, topP: v } })} format={(v) => v.toFixed(2)} />
            <Slider label="Top-K" value={gen.topK} min={0} max={100} step={1}
              onChange={(v) => update({ generation: { ...gen, topK: v } })} />
            <Slider label="Min-P" value={gen.minP} min={0} max={0.5} step={0.01}
              onChange={(v) => update({ generation: { ...gen, minP: v } })} format={(v) => v.toFixed(2)} />
            <Slider label="Repeat penalty" value={gen.repeatPenalty} min={1} max={1.5} step={0.01}
              onChange={(v) => update({ generation: { ...gen, repeatPenalty: v } })} format={(v) => v.toFixed(2)} />
            <Slider label="Max response tokens" value={gen.maxTokens} min={256} max={8192} step={256}
              onChange={(v) => update({ generation: { ...gen, maxTokens: v } })} />
            <div>
              <label className="mb-1.5 block text-[13px] text-sibyl-text">Stop sequences</label>
              <textarea
                value={(gen.stopSequences ?? []).join('\n')}
                onChange={(e) =>
                  update({
                    generation: {
                      ...gen,
                      stopSequences: e.target.value.split('\n').filter(Boolean)
                    }
                  })
                }
                rows={2}
                placeholder="One per line — generation stops when any is produced"
                className="input resize-none font-mono text-[12px]"
              />
            </div>
          </Section>

          <PersonasSection settings={settings} />
          <GenerationProfilesSection settings={settings} />
          <VoiceSpeechSection settings={settings} />

          <Section title="Downloads" desc="Integrity checks applied to models you download.">
            <Toggle
              label="Verify downloads with SHA-256"
              desc="Confirm a download matches Hugging Face's published checksum. Slower for large models; the quick size check always runs."
              checked={settings.verifyDownloads}
              onChange={(v) => update({ verifyDownloads: v })}
            />
          </Section>

          <Section
            title="Hugging Face access"
            desc="Optional token for downloading gated or private models. Stored encrypted via your OS keychain."
          >
            {appInfo && !appInfo.secureStorageAvailable && (
              <p className="text-[12px] text-amber-400/90">
                Secure storage (OS keychain) is unavailable on this system, so a token can’t be
                saved — it would not persist after you restart Sibyl.
              </p>
            )}
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenDirty ? token : settings.hfToken ? '••••••••••••••••' : ''}
                onChange={(e) => {
                  setToken(e.target.value)
                  setTokenDirty(true)
                }}
                placeholder="hf_…"
                className="input flex-1"
              />
              <button
                onClick={() => {
                  update({ hfToken: token.trim() || null })
                  setTokenDirty(false)
                  setToken('')
                }}
                disabled={!tokenDirty}
                className="btn-primary"
              >
                Save
              </button>
              {settings.hfToken && (
                <button
                  onClick={() => {
                    update({ hfToken: null })
                    setTokenDirty(false)
                    setToken('')
                  }}
                  className="btn-ghost"
                >
                  Clear
                </button>
              )}
            </div>
          </Section>

          <Section title="Appearance" desc="Pick an accent palette — it recolors buttons, the assistant caret, your messages and the composer.">
            <div className="flex gap-2">
              {(['dark', 'light'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update({ theme: t })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium capitalize transition-colors ${
                    settings.theme === t
                      ? 'border-sibyl-accent/60 bg-sibyl-accent/15 text-sibyl-text'
                      : 'border-sibyl-border text-sibyl-muted hover:text-sibyl-text'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div>
              <label className="mb-2 block text-[13px] text-sibyl-text">Accent theme</label>
              <div className="flex flex-wrap gap-2">
                {ACCENT_THEMES.map((t) => {
                  const active = settings.accent === t.key
                  return (
                    <button
                      key={t.key}
                      onClick={() => update({ accent: t.key })}
                      title={t.label}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors ${
                        active
                          ? 'border-sibyl-accent/60 bg-sibyl-accent/10 text-sibyl-text'
                          : 'border-sibyl-border text-sibyl-muted hover:text-sibyl-text'
                      }`}
                    >
                      <span className="flex gap-1">
                        <span className="h-3 w-3 rounded-[3px]" style={{ background: t.accent }} />
                        <span className="h-3 w-3 rounded-[3px]" style={{ background: t.accent2 }} />
                      </span>
                      {t.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </Section>

          <Section title="Storage">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] text-sibyl-text">Models directory</p>
                <p className="truncate font-mono text-[11px] text-sibyl-muted" title={settings.modelsDir}>
                  {settings.modelsDir}
                </p>
              </div>
            </div>
          </Section>

          <UpdatesSection />

          <Section title="About">
            <div className="grid grid-cols-2 gap-y-1.5 text-[12px] text-sibyl-muted">
              <span>Sibyl version</span>
              <span className="text-sibyl-text">{appInfo?.version}</span>
              <span>Electron</span>
              <span className="text-sibyl-text">{appInfo?.electron}</span>
              <span>Node</span>
              <span className="text-sibyl-text">{appInfo?.node}</span>
              <span>Platform</span>
              <span className="text-sibyl-text">{appInfo?.platform}</span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-sibyl-muted/80">
              Sibyl runs all inference locally and never transmits your conversations. Model downloads
              are fetched directly from Hugging Face over TLS.
            </p>
          </Section>
        </div>
      </div>
    </div>
  )
}
