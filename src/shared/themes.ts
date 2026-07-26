// Accent themes for Sibyl's chat surface. Pure data + helpers — safe to load in
// the renderer (no node/electron imports). Each theme recolors the app's accent
// pair (and glow) which the Tailwind `sibyl-accent` / `sibyl-accent-2` / `sibyl-glow`
// utilities resolve from CSS variables, so a switch repaints buttons, the user
// bubble, the assistant caret, the composer focus ring, swatches, etc.

export interface AccentTheme {
  key: string
  label: string
  /** Primary accent (buttons, assistant marks, caret). Hex. */
  accent: string
  /** Secondary accent (gradient end, "you" / user voice). Hex. */
  accent2: string
  /** Lighter glow used for inline highlights. Hex. */
  glow: string
}

export const ACCENT_THEMES = [
  // Original Sibyl identity — deep indigo night with an arcane violet accent.
  { key: 'arcane', label: 'Arcane', accent: '#9a76e6', accent2: '#b28be6', glow: '#c7b0f4' },
  { key: 'rose', label: 'Rose', accent: '#ffa3b8', accent2: '#a8b0ff', glow: '#ffc2d4' },
  { key: 'synth', label: 'Synthwave', accent: '#5ee7ff', accent2: '#ff66c4', glow: '#9beeff' },
  { key: 'phosphor', label: 'Phosphor', accent: '#7cf5a0', accent2: '#ffc266', glow: '#b3f8cb' },
  { key: 'peach', label: 'Peach', accent: '#ffbfa3', accent2: '#a3d8ff', glow: '#ffd6c4' },
  { key: 'ink', label: 'Ink', accent: '#e7e9f3', accent2: '#9a9aa3', glow: '#f4f5f9' },
  { key: 'ember', label: 'Ember', accent: '#ffb59a', accent2: '#ffa3b8', glow: '#ffcdb8' }
] as const satisfies readonly AccentTheme[]

export type AccentThemeKey = (typeof ACCENT_THEMES)[number]['key']

export const DEFAULT_ACCENT: AccentThemeKey = 'arcane'

/** Resolve a theme by key, falling back to the default for unknown/legacy values. */
export function getAccentTheme(key: string | null | undefined): AccentTheme {
  return ACCENT_THEMES.find((t) => t.key === key) ?? ACCENT_THEMES[0]
}

/**
 * Convert `#rrggbb` (or `#rgb`) to a space-separated `"r g b"` channel string for
 * use in `rgb(var(--x) / <alpha-value>)` — the form Tailwind needs so opacity
 * modifiers (e.g. `bg-sibyl-accent/20`) keep working after theming.
 */
export function hexToRgbChannels(hex: string): string {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `${r} ${g} ${b}`
}
