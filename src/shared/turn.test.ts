import { describe, expect, it } from 'vitest'
import {
  beginRendererTurn,
  IDLE_RENDERER_TURN,
  rendererTurnIsBusy,
  rendererTurnMatches,
  transitionRendererTurn
} from './turn'

describe('renderer turn state', () => {
  const operation = {
    operationId: 'turn-1',
    kind: 'scene' as const,
    conversationId: 'conv-1'
  }

  it('claims synchronously and rejects every overlapping busy phase', () => {
    const preparing = beginRendererTurn(IDLE_RENDERER_TURN, operation)!
    expect(preparing.phase).toBe('preparing')
    for (const phase of [
      'preparing',
      'compacting',
      'generating',
      'stopping',
      'narration-pending',
      'narrating'
    ] as const) {
      expect(rendererTurnIsBusy({ ...preparing, phase })).toBe(true)
      expect(beginRendererTurn({ ...preparing, phase }, operation)).toBeNull()
    }
  })

  it('allows a new operation after complete or failed', () => {
    expect(beginRendererTurn({ phase: 'complete' }, operation)?.phase).toBe('preparing')
    expect(beginRendererTurn({ phase: 'failed', error: 'nope' }, operation)?.phase).toBe(
      'preparing'
    )
  })

  it('ignores stale transitions and matches terminal events by conversation and message', () => {
    const current = {
      ...operation,
      phase: 'generating' as const,
      messageId: 'msg-1'
    }
    expect(transitionRendererTurn(current, 'old-turn', { phase: 'failed' })).toBe(current)
    expect(transitionRendererTurn(current, 'turn-1', { phase: 'stopping' }).phase).toBe(
      'stopping'
    )
    expect(rendererTurnMatches(current, 'conv-1', 'msg-1')).toBe(true)
    expect(rendererTurnMatches(current, 'conv-2', 'msg-1')).toBe(false)
  })
})
