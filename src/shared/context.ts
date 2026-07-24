// Pure helpers for context-window accounting and presentation.
// No runtime deps so it is safe in the renderer and unit-testable.

import type { ContextLevel, ContextUsage } from './types'

/** True only when a usage response still belongs to the requested, visible thread. */
export function contextUsageIsCurrent(
  usage: Pick<ContextUsage, 'conversationId'> | null | undefined,
  requestedConversationId: string | null,
  activeConversationId: string | null
): boolean {
  return (
    requestedConversationId === activeConversationId &&
    usage?.conversationId === requestedConversationId
  )
}

/**
 * Classify how full the context window is. `warn` and `critical` are fractions
 * (0..1); `critical` is where auto-compaction kicks in and should be >= `warn`.
 */
export function contextLevel(fraction: number, warn: number, critical: number): ContextLevel {
  if (!Number.isFinite(fraction)) return 'ok'
  if (fraction >= critical) return 'critical'
  if (fraction >= warn) return 'warn'
  return 'ok'
}

/**
 * Cheap, dependency-free token estimate for live UI (e.g. the composer counter).
 * Approximates ~4 chars/token — the same fallback the engine uses when the real
 * tokenizer is unavailable. Not exact; prefix displays with "~".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Compact a token count to a short label, e.g. 950 → "950", 8400 → "8.4K". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const r = Math.round(n)
  if (r < 1000) return String(r)
  const k = r / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`
}

/** Whole-percent fill for a 0..1 fraction, clamped to 0..100. */
export function contextPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0
  return Math.min(100, Math.round(fraction * 100))
}

/**
 * Token budget for a folded-history summary, scaled to the window so a large
 * context doesn't get stuck with a tiny summary (the old behaviour was a fixed
 * 600). `fraction` of `contextSize`, clamped to a sane floor/ceiling. Falls back
 * to 600 when the context size is unknown.
 */
export function summaryBudgetTokens(contextSize: number, fraction: number): number {
  if (!Number.isFinite(contextSize) || contextSize <= 0) return 600
  const f = Number.isFinite(fraction) && fraction > 0 ? fraction : 0.06
  return Math.min(2000, Math.max(256, Math.round(contextSize * f)))
}

/**
 * How many of the most recent messages to keep verbatim during compaction.
 * Keeps up to `maxKeep` (the user's keepRecentMessages), but folds more when the
 * recent tail is large so the post-compaction live tail fits `keepBudgetTokens` —
 * a fixed count alone can't guarantee compaction frees enough. Always keeps at
 * least `minKeep` (even if they exceed the budget, so there's some live context;
 * the caller's fit check then warns). `recentTokens` is newest-first.
 */
export function keepRecentCount(
  recentTokens: number[],
  maxKeep: number,
  keepBudgetTokens: number,
  minKeep = 2
): number {
  const cap = Math.max(0, Math.floor(maxKeep))
  const floor = Math.min(Math.max(0, Math.floor(minKeep)), cap)
  let total = 0
  let keep = 0
  for (const t of recentTokens) {
    if (keep >= cap) break
    const next = total + (t > 0 ? t : 0)
    if (keep >= floor && next > keepBudgetTokens) break
    total = next
    keep++
  }
  return keep
}

/** Tailwind text/bg accent class per severity, for consistent meter colours. */
export function levelColor(level: ContextLevel): { text: string; bar: string } {
  switch (level) {
    case 'critical':
      return { text: 'text-rose-400', bar: 'bg-rose-500' }
    case 'warn':
      return { text: 'text-amber-400', bar: 'bg-amber-500' }
    default:
      return { text: 'text-sibyl-muted', bar: 'bg-sibyl-accent' }
  }
}
