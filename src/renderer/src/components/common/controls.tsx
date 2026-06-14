// Reusable form controls shared by the Settings view and the per-conversation
// overrides drawer. Pure presentational components — no store access.

export function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <h2 className="text-[15px] font-semibold text-oracle-text">{title}</h2>
      {desc && <p className="mt-0.5 text-[12.5px] text-oracle-muted">{desc}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'opacity-40' : ''}>
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
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="oracle-range w-full"
      />
    </div>
  )
}

export function Toggle({
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
