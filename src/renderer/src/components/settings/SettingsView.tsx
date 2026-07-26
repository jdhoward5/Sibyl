import { useState } from 'react'
import { actions, uid, useStore } from '../../store'
import type { GenerationProfile, RendererSettings, RendererSettingsPatch } from '@shared/types'
import { TTS_VOICE_CATALOG } from '@shared/tts'
import { formatBytes } from '@shared/format'
import { Section, Slider, Toggle } from '../common/controls'
import {
  PortableExportDialog,
  PortableImportDialog
} from '../PortableDataDialogs'
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

/** Manage reusable generation-parameter profiles; apply one to the global params. */
function GenerationProfilesSection({ settings }: { settings: RendererSettings }) {
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
function VoiceSpeechSection({ settings }: { settings: RendererSettings }) {
  const tts = settings.tts
  const status = useStore((s) => s.tts)
  const installed = useStore((s) => s.installedVoices)
  const downloads = useStore((s) => s.voiceDownloads)
  const speaking = useStore((s) => s.speakingMessageId)
  const available = status?.available ?? false

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
          const installedVoice = installed.find((voice) => voice.id === v.id)
          const isInstalled = Boolean(installedVoice)
          const isUsable =
            isInstalled &&
            (!installedVoice?.availability || installedVoice.availability === 'available')
          const dl = downloads[v.id]
          const isActive = tts.voiceId === v.id && isUsable
          const pct = dl && dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : 0
          return (
            <div
              key={v.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                isActive ? 'border-sibyl-accent/60 bg-sibyl-accent/10' : 'border-sibyl-border/60'
              }`}
            >
              <button
                onClick={() => isUsable && actions.updateTtsSettings({ voiceId: v.id, enabled: true })}
                disabled={!isUsable}
                title={isUsable ? 'Use this voice' : 'Download or repair to use'}
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
                  {installedVoice?.availability &&
                    installedVoice.availability !== 'available' &&
                    ` · ${installedVoice.availability}`}
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
              ) : isInstalled && !isUsable ? (
                <button
                  onClick={() => actions.downloadVoice(v.id)}
                  disabled={!available}
                  className="btn-surface shrink-0 px-2.5 py-1 text-[12px] disabled:opacity-40"
                  title={installedVoice?.availabilityError ?? 'Repair voice files'}
                >
                  <DownloadIcon size={13} /> Repair
                </button>
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

type SettingsCategory =
  | 'models'
  | 'generation'
  | 'voice'
  | 'privacy'
  | 'appearance'
  | 'system'

const SETTINGS_CATEGORIES: { key: SettingsCategory; label: string; desc: string }[] = [
  { key: 'models', label: 'Models', desc: 'Loading and access' },
  { key: 'generation', label: 'Generation', desc: 'Context and sampling' },
  { key: 'voice', label: 'Voice', desc: 'On-device speech' },
  { key: 'privacy', label: 'Privacy & data', desc: 'Vault and portability' },
  { key: 'appearance', label: 'Appearance', desc: 'Reading and motion' },
  { key: 'system', label: 'System', desc: 'Storage and updates' }
]

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const vault = useStore((s) => s.vault)
  const vaultBackups = useStore((s) => s.vaultBackups)
  const appInfo = useStore((s) => s.appInfo)
  const engine = useStore((s) => s.engine)
  const storageIssues = useStore((s) => s.storageIssues)
  const [token, setToken] = useState('')
  const [tokenDirty, setTokenDirty] = useState(false)
  const [newRecoveryPassphrase, setNewRecoveryPassphrase] = useState('')
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('')
  const [changingRecovery, setChangingRecovery] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [passkeyWorking, setPasskeyWorking] = useState(false)
  const [portableExportOpen, setPortableExportOpen] = useState(false)
  const [portableImportOpen, setPortableImportOpen] = useState(false)
  const [category, setCategory] = useState<SettingsCategory>('models')

  if (!settings) return null

  const update = (patch: RendererSettingsPatch): void => void actions.updateSettings(patch)
  const gen = settings.generation
  const load = settings.load
  const ctx = settings.context

  // Offer only the backends that exist on the current OS: Metal on macOS,
  // CUDA/Vulkan on Windows. 'Auto' and 'CPU' are always valid.
  const isMac = appInfo?.platform === 'darwin'
  const gpuOptions: { value: RendererSettings['gpu']; label: string }[] = isMac
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
    <div className="flex min-h-0 flex-1">
      <aside className="w-[218px] shrink-0 border-r border-sibyl-border/60 bg-sibyl-sunken px-3 py-5">
        <div className="eyebrow mb-3 px-3 text-sibyl-accent">Settings</div>
        <nav aria-label="Settings categories" className="flex flex-col gap-1">
          {SETTINGS_CATEGORIES.map((item) => (
            <button
              key={item.key}
              onClick={() => setCategory(item.key)}
              aria-current={category === item.key ? 'page' : undefined}
              className={`rounded-lg px-3 py-2.5 text-left transition-colors ${
                category === item.key
                  ? 'bg-sibyl-surface-2 text-sibyl-text'
                  : 'text-sibyl-muted hover:bg-sibyl-surface hover:text-sibyl-text'
              }`}
            >
              <span className="block text-[13px] font-medium">{item.label}</span>
              <span className="mt-0.5 block text-[10.5px] text-sibyl-faint">{item.desc}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-8 py-7">
          <div className="eyebrow mb-2 text-sibyl-accent">
            {SETTINGS_CATEGORIES.find((item) => item.key === category)?.label}
          </div>
          <h1 className="display-title mb-6 text-[26px]">
            {SETTINGS_CATEGORIES.find((item) => item.key === category)?.desc}
          </h1>
          <div className="flex flex-col gap-4">
          <div className={category === 'models' ? 'contents' : 'hidden'}>
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
              <label htmlFor="global-character-brief" className="mb-1.5 block text-[13px] text-sibyl-text">Character brief</label>
              <p className="mb-1.5 text-[12px] text-sibyl-muted">
                The default brief for blank conversations. Characters override it per conversation.
              </p>
              <textarea
                id="global-character-brief"
                value={load.systemPrompt}
                onChange={(e) =>
                  actions.queueTextSettings({ load: { ...load, systemPrompt: e.target.value } })
                }
                onBlur={() => void actions.flushTextSettings()}
                rows={3}
                className="input resize-none"
              />
            </div>
          </Section>
          </div>

          <div className={category === 'generation' ? 'contents' : 'hidden'}>
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
                  actions.queueTextSettings({
                    generation: {
                      ...gen,
                      stopSequences: e.target.value.split('\n').filter(Boolean)
                    }
                  })
                }
                onBlur={() => void actions.flushTextSettings()}
                rows={2}
                placeholder="One per line — generation stops when any is produced"
                className="input resize-none font-mono text-[12px]"
              />
            </div>
          </Section>

          <GenerationProfilesSection settings={settings} />
          </div>

          <div className={category === 'voice' ? 'contents' : 'hidden'}>
          <VoiceSpeechSection settings={settings} />
          </div>

          <div className={category === 'appearance' ? 'contents' : 'hidden'}>
          <Section
            title="Accessibility"
            desc="Reading, contrast, and motion preferences for the whole app."
          >
            <Toggle
              label="Reduce motion"
              desc="Disables decorative transitions, pulsing indicators, and smooth animation."
              checked={settings.accessibility.reducedMotion}
              onChange={(reducedMotion) =>
                actions.updateAccessibilitySettings({ reducedMotion })
              }
            />
            <Toggle
              label="High contrast"
              desc="Strengthens borders, focus rings, muted text, and interactive states."
              checked={settings.accessibility.highContrast}
              onChange={(highContrast) =>
                actions.updateAccessibilitySettings({ highContrast })
              }
            />
            <div>
              <label htmlFor="text-scale" className="mb-1.5 block text-[13px] text-sibyl-text">
                Text size
              </label>
              <select
                id="text-scale"
                value={settings.accessibility.textScale}
                onChange={(event) =>
                  actions.updateAccessibilitySettings({
                    textScale: Number(event.target.value) as
                      RendererSettings['accessibility']['textScale']
                  })
                }
                className="input h-9 py-0 text-[13px]"
              >
                <option value={1}>Default</option>
                <option value={1.125}>Large · 112.5%</option>
                <option value={1.25}>Larger · 125%</option>
              </select>
            </div>
          </Section>
          </div>

          <div className={category === 'models' ? 'contents' : 'hidden'}>
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
                value={tokenDirty ? token : settings.hfTokenConfigured ? '••••••••••••••••' : ''}
                onFocus={() => {
                  if (!tokenDirty && settings.hfTokenConfigured) {
                    setToken('')
                    setTokenDirty(true)
                  }
                }}
                onBlur={() => {
                  if (tokenDirty && !token) setTokenDirty(false)
                }}
                onChange={(e) => {
                  setToken(e.target.value)
                  setTokenDirty(true)
                }}
                placeholder="hf_…"
                className="input flex-1"
              />
              <button
                onClick={() => {
                  const next = token.trim()
                  if (!next) return
                  void actions.setHfToken(next).then((saved) => {
                    if (!saved) return
                    setTokenDirty(false)
                    setToken('')
                  })
                }}
                disabled={!tokenDirty}
                className="btn-primary"
              >
                Save
              </button>
              {settings.hfTokenConfigured && (
                <button
                  onClick={() => {
                    void actions.clearHfToken().then((cleared) => {
                      if (!cleared) return
                      setTokenDirty(false)
                      setToken('')
                    })
                  }}
                  className="btn-ghost"
                >
                  Clear
                </button>
              )}
            </div>
          </Section>
          </div>

          <div className={category === 'privacy' ? 'contents' : 'hidden'}>
          {vault?.state === 'unlocked' && (
            <Section
              title="Private data protection"
              desc="Conversations, characters, prompts, and their metadata are encrypted at rest."
            >
                <Toggle
                  label="Unlock seamlessly on this device"
                desc={
                  vault.deviceStorageAvailable
                    ? 'Uses the operating-system keychain. Turn this off to require your recovery passphrase whenever Sibyl opens.'
                    : 'Secure device storage is unavailable, so your recovery passphrase is required whenever Sibyl opens.'
                }
                checked={vault.hasDeviceSlot}
                disabled={!vault.deviceStorageAvailable}
                  onChange={(enabled) => void actions.setVaultSeamless(enabled)}
                />
                {vault.passkeyAvailable && (
                  <Toggle
                    label="Unlock with a passkey"
                    desc="Uses Windows Hello, Touch ID, or another PRF-capable authenticator. Your recovery passphrase remains available if the passkey is lost."
                    checked={vault.hasPasskeySlot}
                    disabled={passkeyWorking}
                    onChange={(enabled) => {
                      setPasskeyWorking(true)
                      void actions
                        .setVaultPasskey(enabled)
                        .finally(() => setPasskeyWorking(false))
                    }}
                  />
                )}
              <div className="flex items-center justify-between gap-4">
                <p className="text-[12px] leading-relaxed text-sibyl-muted">
                  Locking stops active speech and model work, clears private in-memory state, and
                  returns to the unlock screen.
                </p>
                <button
                  type="button"
                  onClick={() => void actions.lockVault()}
                  className="btn-surface shrink-0"
                >
                  Lock now
                </button>
              </div>
              <p className="text-[11.5px] leading-relaxed text-sibyl-muted/80">
                Your recovery passphrase is still required after copying the vault to different
                hardware or losing access to this device’s keychain.
              </p>
              <div className="border-t border-sibyl-border/60 pt-4">
                <p className="mb-2 text-[13px] font-medium text-sibyl-text">
                  Change recovery passphrase
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    type="password"
                    value={newRecoveryPassphrase}
                    autoComplete="new-password"
                    placeholder="New passphrase"
                    aria-label="New recovery passphrase"
                    onChange={(event) => setNewRecoveryPassphrase(event.target.value)}
                    className="input"
                  />
                  <input
                    type="password"
                    value={recoveryConfirmation}
                    autoComplete="new-password"
                    placeholder="Confirm passphrase"
                    aria-label="Confirm new recovery passphrase"
                    onChange={(event) => setRecoveryConfirmation(event.target.value)}
                    className="input"
                  />
                </div>
                {recoveryError && (
                  <p role="alert" className="mt-2 text-[12px] text-red-300">
                    {recoveryError}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11.5px] leading-relaxed text-sibyl-muted">
                    Use at least 12 characters; several unique words are recommended.
                  </p>
                  <button
                    type="button"
                    disabled={changingRecovery}
                    onClick={() => {
                      setRecoveryError(null)
                      if (newRecoveryPassphrase.length < 12) {
                        setRecoveryError('Use at least 12 characters.')
                        return
                      }
                      if (newRecoveryPassphrase !== recoveryConfirmation) {
                        setRecoveryError('The passphrases do not match.')
                        return
                      }
                      setChangingRecovery(true)
                      void actions
                        .changeVaultRecoveryPassphrase(newRecoveryPassphrase)
                        .then((changed) => {
                          if (changed) {
                            setNewRecoveryPassphrase('')
                            setRecoveryConfirmation('')
                          }
                        })
                        .finally(() => setChangingRecovery(false))
                    }}
                    className="btn-surface shrink-0"
                  >
                    {changingRecovery ? 'Changing…' : 'Change'}
                  </button>
                </div>
              </div>
              <div className="border-t border-sibyl-border/60 pt-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium text-sibyl-text">
                      Encrypted recovery snapshots
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-sibyl-muted">
                      Sibyl rotates ciphertext-only snapshots before private-data changes.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => void actions.verifyVaultRecovery()}
                      className="btn-surface"
                    >
                      Run recovery drill
                    </button>
                    <button
                      type="button"
                      onClick={() => void actions.createVaultBackup()}
                      className="btn-surface"
                    >
                      Snapshot now
                    </button>
                  </div>
                </div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <label htmlFor="backup-retention" className="text-[12px] text-sibyl-muted">
                    Snapshots to retain
                  </label>
                  <select
                    id="backup-retention"
                    value={settings.backupRetention}
                    onChange={(event) =>
                      update({
                        backupRetention: Number(event.target.value) as
                          RendererSettings['backupRetention']
                      })
                    }
                    className="input h-8 w-24 py-0 text-[12px]"
                  >
                    {[1, 3, 5, 10].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </div>
                {vaultBackups.length === 0 ? (
                  <p className="text-[12px] text-sibyl-muted">
                    A snapshot will be created before the next private-data change.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {vaultBackups.map((backup) => (
                      <div
                        key={backup.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-sibyl-border/60 px-3 py-2"
                      >
                        <div>
                          <p className="text-[12.5px] text-sibyl-text">
                            {backup.valid ? 'Verified snapshot' : 'Damaged snapshot'}
                          </p>
                          <p className="mt-0.5 text-[11px] text-sibyl-muted">
                            {new Date(backup.createdAt).toLocaleString()}
                            {backup.valid ? ` · ${backup.recordCount} encrypted records` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={!backup.valid}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Restore this encrypted snapshot? Sibyl will first preserve the current vault as another snapshot, then reload.'
                              )
                            ) {
                              void actions.restoreVaultBackup(backup.id)
                            }
                          }}
                          className="btn-surface shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section
            title="Encrypted portability"
            desc="Move or archive private data without writing conversation content or semantic metadata in plaintext."
          >
            <p className="text-[12px] leading-relaxed text-sibyl-muted">
              A portable bundle has a fresh encryption key and its own recovery
              passphrase. Model files and Hugging Face credentials are never included;
              only portable model references are carried.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setPortableExportOpen(true)}
                className="btn-surface justify-center"
              >
                Export encrypted library
              </button>
              <button
                type="button"
                onClick={() => setPortableImportOpen(true)}
                className="btn-surface justify-center"
              >
                Import encrypted bundle
              </button>
            </div>
          </Section>
          </div>

          <div className={category === 'system' ? 'contents' : 'hidden'}>
          <Section title="Storage">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] text-sibyl-text">Models directory</p>
                <p className="truncate font-mono text-[11px] text-sibyl-muted" title={settings.modelsDir}>
                  {settings.modelsDir}
                </p>
              </div>
            </div>
            {storageIssues.map((issue) => (
              <div
                key={issue.resource}
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2.5"
              >
                <p className="text-[12px] text-amber-200">{issue.message}</p>
                {issue.recoverable ? (
                  <button
                    onClick={() => void actions.revealStorageRecovery(issue.resource)}
                    className="btn-surface shrink-0 px-2.5 py-1 text-[12px]"
                  >
                    Show recovery copy
                  </button>
                ) : (
                  <button
                    onClick={() => void actions.retryStorage(issue.resource)}
                    className="btn-surface shrink-0 px-2.5 py-1 text-[12px]"
                  >
                    Retry access
                  </button>
                )}
              </div>
            ))}
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
      </div>
      {portableExportOpen && (
        <PortableExportDialog onClose={() => setPortableExportOpen(false)} />
      )}
      {portableImportOpen && (
        <PortableImportDialog onClose={() => setPortableImportOpen(false)} />
      )}
    </div>
  )
}
