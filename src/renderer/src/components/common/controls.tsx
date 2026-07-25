import { useId } from 'react'

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
      <h2 className="text-[15px] font-semibold text-sibyl-text">{title}</h2>
      {desc && <p className="mt-0.5 text-[12.5px] text-sibyl-muted">{desc}</p>}
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
  const id = useId()
  const valueText = format ? format(value) : String(value)
  return (
    <div className={disabled ? 'opacity-40' : ''}>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-[13px] text-sibyl-text">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-[12px] text-sibyl-accent">
          {valueText}
        </output>
      </div>
      <input
        id={id}
        type="range"
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="sibyl-range w-full"
      />
    </div>
  )
}

export function Toggle({
  label,
  desc,
  checked,
  disabled,
  onChange
}: {
  label: string
  desc?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? 'opacity-50' : ''}`}>
      <div className="min-w-0">
        <span id={labelId} className="text-[13px] text-sibyl-text">
          {label}
        </span>
        {desc && (
          <p id={descriptionId} className="mt-0.5 text-[12px] text-sibyl-muted">
            {desc}
          </p>
        )}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={desc ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${
          checked ? 'bg-sibyl-accent' : 'bg-sibyl-surface-2'
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
}
