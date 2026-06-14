import { useState } from 'react'
import { actions, useStore } from '../../store'
import type { AppSettings } from '@shared/types'

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-[15px] font-semibold text-oracle-text">{title}</h2>
      {desc && <p className="mt-0.5 text-[12.5px] text-oracle-muted">{desc}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[13px] text-oracle-text">{label}</label>
        <span className="font-mono text-[12px] text-oracle-accent">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="oracle-range w-full"
      />
    </div>
  )
}

function Toggle({
  label,
  desc,
  checked,
  onChange
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label className="text-[13px] text-oracle-text">{label}</label>
        {desc && <p className="mt-0.5 text-[12px] text-oracle-muted">{desc}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-oracle-accent' : 'bg-oracle-surface-2'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
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

  const gpuOptions: { value: AppSettings['gpu']; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'cuda', label: 'CUDA' },
    { value: 'vulkan', label: 'Vulkan' },
    { value: 'cpu', label: 'CPU' }
  ]

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-5 text-xl font-semibold text-oracle-text">Settings</h1>
        <div className="flex flex-col gap-4">
          <Section title="Inference backend" desc="How models are accelerated. Changes apply when you next load a model.">
            <div className="flex gap-2">
              {gpuOptions.map((o) => (
                <button
                  key={o.value}
                  onClick={() => update({ gpu: o.value })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
                    settings.gpu === o.value
                      ? 'border-oracle-accent/60 bg-oracle-accent/15 text-oracle-text'
                      : 'border-oracle-border text-oracle-muted hover:text-oracle-text'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {engine.gpuType && (
              <p className="text-[12px] text-oracle-muted">
                Active backend:{' '}
                <span className="text-oracle-glow">{String(engine.gpuType).toUpperCase()}</span>
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
              <label className="mb-1.5 block text-[13px] text-oracle-text">System prompt</label>
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
            desc="How Oracle keeps long chats inside the model's context window."
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
          </Section>

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
                saved — it would not persist after you restart Oracle.
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

          <Section title="Appearance">
            <div className="flex gap-2">
              {(['dark', 'light'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update({ theme: t })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium capitalize transition-colors ${
                    settings.theme === t
                      ? 'border-oracle-accent/60 bg-oracle-accent/15 text-oracle-text'
                      : 'border-oracle-border text-oracle-muted hover:text-oracle-text'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Storage">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] text-oracle-text">Models directory</p>
                <p className="truncate font-mono text-[11px] text-oracle-muted" title={settings.modelsDir}>
                  {settings.modelsDir}
                </p>
              </div>
            </div>
          </Section>

          <Section title="About">
            <div className="grid grid-cols-2 gap-y-1.5 text-[12px] text-oracle-muted">
              <span>Oracle version</span>
              <span className="text-oracle-text">{appInfo?.version}</span>
              <span>Electron</span>
              <span className="text-oracle-text">{appInfo?.electron}</span>
              <span>Node</span>
              <span className="text-oracle-text">{appInfo?.node}</span>
              <span>Platform</span>
              <span className="text-oracle-text">{appInfo?.platform}</span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-oracle-muted/80">
              Oracle runs all inference locally and never transmits your conversations. Model downloads
              are fetched directly from Hugging Face over TLS.
            </p>
          </Section>
        </div>
      </div>
    </div>
  )
}
