// Pure renderer-operation state helpers. Keeping transition rules here makes the
// async UI orchestration deterministic and unit-testable without a DOM.

export type RendererTurnPhase =
  | 'idle'
  | 'preparing'
  | 'compacting'
  | 'generating'
  | 'stopping'
  | 'narration-pending'
  | 'narrating'
  | 'complete'
  | 'failed'

export type RendererTurnKind = 'chat' | 'scene' | 'compact'

export interface RendererTurnState {
  phase: RendererTurnPhase
  operationId?: string
  kind?: RendererTurnKind
  conversationId?: string
  messageId?: string
  error?: string
}

export const IDLE_RENDERER_TURN: RendererTurnState = { phase: 'idle' }

const BUSY_PHASES = new Set<RendererTurnPhase>([
  'preparing',
  'compacting',
  'generating',
  'stopping',
  'narration-pending',
  'narrating'
])

export function rendererTurnIsBusy(turn: RendererTurnState): boolean {
  return BUSY_PHASES.has(turn.phase)
}

export function beginRendererTurn(
  current: RendererTurnState,
  operation: Required<Pick<RendererTurnState, 'operationId' | 'kind' | 'conversationId'>>
): RendererTurnState | null {
  if (rendererTurnIsBusy(current)) return null
  return { phase: 'preparing', ...operation }
}

/** Ignore late transitions from an operation that no longer owns renderer state. */
export function transitionRendererTurn(
  current: RendererTurnState,
  operationId: string,
  patch: Partial<Omit<RendererTurnState, 'operationId'>>
): RendererTurnState {
  if (current.operationId !== operationId) return current
  return { ...current, ...patch, operationId }
}

export function rendererTurnMatches(
  turn: RendererTurnState,
  conversationId: string,
  messageId: string
): boolean {
  return turn.conversationId === conversationId && turn.messageId === messageId
}
