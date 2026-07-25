import type {
  ChatMessage,
  Conversation,
  KnowledgeVisibility,
  Persona,
  PersonaSnapshot,
  RoleplayFact,
  SceneDirection,
  ScenePersonaOverride
} from './types'
import { findPersona } from './personas'

export const PERSONA_SCHEMA_VERSION = 2 as const
export const CONVERSATION_SCHEMA_VERSION = 2 as const
export const PERSONA_PROMPT_BUDGET_CHARS = 12_000
export const RELATIONSHIP_PROMPT_BUDGET_CHARS = 4_000
export const ROLEPLAY_STATE_PROMPT_BUDGET_CHARS = 8_000
export const DIRECTION_PROMPT_BUDGET_CHARS = 4_000

function clip(text: string | undefined, remaining: number): string {
  const clean = text?.trim() ?? ''
  if (remaining <= 0 || !clean) return ''
  return clean.length <= remaining ? clean : `${clean.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`
}

function appendBudgeted(lines: string[], label: string, values: string[] | undefined, budget: number): number {
  for (const value of values ?? []) {
    const prefix = `- ${label}: `
    const text = clip(value, budget - prefix.length)
    if (!text) break
    lines.push(`${prefix}${text}`)
    budget -= prefix.length + text.length + 1
  }
  return budget
}

export function normalizePersona(persona: Persona): Persona {
  return {
    ...persona,
    schemaVersion: PERSONA_SCHEMA_VERSION,
    version: Math.max(1, persona.version ?? 1),
    publicDescription: persona.publicDescription?.trim() || undefined,
    privateMotivations: persona.privateMotivations?.map((x) => x.trim()).filter(Boolean),
    secrets: persona.secrets?.map((x) => x.trim()).filter(Boolean),
    behavioralConstraints: persona.behavioralConstraints?.map((x) => x.trim()).filter(Boolean),
    speechGuidance: persona.speechGuidance?.trim() || undefined,
    relationships: persona.relationships?.map((relationship) => ({
      ...relationship,
      summary: relationship.summary.trim()
    })).filter((relationship) => relationship.summary),
    voice: persona.voice && (persona.voice.voiceId || persona.voice.rate)
      ? { ...persona.voice }
      : undefined
  }
}

export function snapshotPersona(persona: Persona, capturedAt: string): PersonaSnapshot {
  const normalized = normalizePersona(persona)
  return {
    schemaVersion: 1,
    sourcePersonaId: normalized.id,
    sourceVersion: normalized.version ?? 1,
    capturedAt,
    persona: structuredClone(normalized)
  }
}

export function migrateConversationIdentity(
  conversation: Conversation,
  personas: Persona[],
  capturedAt = conversation.createdAt
): Conversation {
  const snapshots = new Map(
    (conversation.castSnapshots ?? []).map((snapshot) => [snapshot.sourcePersonaId, snapshot])
  )
  for (const id of conversation.cast ?? []) {
    if (!snapshots.has(id)) {
      const persona = findPersona(personas, id)
      if (persona) snapshots.set(id, snapshotPersona(persona, capturedAt))
    }
  }
  const personaSnapshot =
    conversation.personaSnapshot ??
    (conversation.personaId
      ? (() => {
          const persona = findPersona(personas, conversation.personaId)
          return persona ? snapshotPersona(persona, capturedAt) : undefined
        })()
      : undefined)
  return {
    ...conversation,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    personaSnapshot,
    castSnapshots: conversation.cast?.length
      ? conversation.cast
          .map((id) => snapshots.get(id))
          .filter((snapshot): snapshot is PersonaSnapshot => Boolean(snapshot))
      : conversation.castSnapshots,
    knowledgeMode: conversation.knowledgeMode ?? 'scoped',
    roleplayState: conversation.roleplayState ?? {
      schemaVersion: 1,
      facts: [],
      beatsSinceMaintenance: 0
    },
    directions: conversation.directions ?? []
  }
}

function overridePersona(persona: Persona, override: ScenePersonaOverride | undefined): Persona {
  if (!override) return persona
  return {
    ...persona,
    publicDescription: override.publicDescription ?? persona.publicDescription,
    privateMotivations: override.privateMotivations ?? persona.privateMotivations,
    secrets: override.secrets ?? persona.secrets,
    behavioralConstraints: override.behavioralConstraints ?? persona.behavioralConstraints,
    speechGuidance: override.speechGuidance ?? persona.speechGuidance,
    relationships: override.relationships ?? persona.relationships,
    voice: override.voice ?? persona.voice
  }
}

/** Resolve frozen conversation identity first; the live library is only a legacy fallback. */
export function resolveConversationPersona(
  conversation: Pick<Conversation, 'personaId' | 'personaSnapshot' | 'castSnapshots' | 'personaOverrides'>,
  id: string | null | undefined,
  personas: Persona[] | undefined
): Persona | null {
  if (!id) return null
  const frozen =
    conversation.personaSnapshot?.sourcePersonaId === id
      ? conversation.personaSnapshot.persona
      : conversation.castSnapshots?.find((snapshot) => snapshot.sourcePersonaId === id)?.persona
  const base = frozen ?? findPersona(personas, id)
  if (!base) return null
  return overridePersona(base, conversation.personaOverrides?.find((item) => item.personaId === id))
}

export function refreshPersonaSnapshot(
  conversation: Conversation,
  persona: Persona,
  capturedAt: string
): Conversation {
  const snapshot = snapshotPersona(persona, capturedAt)
  if (conversation.personaId === persona.id) {
    return { ...conversation, schemaVersion: 2, personaSnapshot: snapshot }
  }
  if (conversation.cast?.includes(persona.id)) {
    const rest = (conversation.castSnapshots ?? []).filter(
      (item) => item.sourcePersonaId !== persona.id
    )
    const byId = new Map([...rest, snapshot].map((item) => [item.sourcePersonaId, item]))
    return {
      ...conversation,
      schemaVersion: 2,
      castSnapshots: conversation.cast
        .map((id) => byId.get(id))
        .filter((item): item is PersonaSnapshot => Boolean(item))
    }
  }
  return conversation
}

/** Sever a conversation participant from a library id while preserving identity. */
export function detachPersonaIdentity(
  conversation: Conversation,
  personaId: string,
  detachedId: string
): Conversation {
  const replaceVisibility = (visibility: KnowledgeVisibility): KnowledgeVisibility =>
    visibility.kind === 'private'
      ? {
          kind: 'private',
          characterIds: visibility.characterIds.map((id) =>
            id === personaId ? detachedId : id
          )
        }
      : visibility
  const replacePersona = (persona: Persona): Persona => ({
    ...persona,
    id: persona.id === personaId ? detachedId : persona.id,
    relationships: persona.relationships?.map((relationship) => ({
      ...relationship,
      personaId: relationship.personaId === personaId ? detachedId : relationship.personaId
    }))
  })
  const replaceSnapshot = (snapshot: PersonaSnapshot): PersonaSnapshot => ({
    ...snapshot,
    sourcePersonaId:
      snapshot.sourcePersonaId === personaId ? detachedId : snapshot.sourcePersonaId,
    persona: replacePersona(snapshot.persona)
  })
  return {
    ...conversation,
    personaId: conversation.personaId === personaId ? detachedId : conversation.personaId,
    personaSnapshot: conversation.personaSnapshot
      ? replaceSnapshot(conversation.personaSnapshot)
      : undefined,
    cast: conversation.cast?.map((id) => (id === personaId ? detachedId : id)),
    castSnapshots: conversation.castSnapshots?.map(replaceSnapshot),
    personaOverrides: conversation.personaOverrides?.map((override) => ({
      ...override,
      personaId: override.personaId === personaId ? detachedId : override.personaId,
      relationships: override.relationships?.map((relationship) => ({
        ...relationship,
        personaId:
          relationship.personaId === personaId ? detachedId : relationship.personaId
      }))
    })),
    messages: conversation.messages.map((message) => ({
      ...message,
      speakerId: message.speakerId === personaId ? detachedId : message.speakerId,
      segments: message.segments?.map((segment) => ({
        ...segment,
        visibility: replaceVisibility(segment.visibility)
      }))
    })),
    roleplayState: conversation.roleplayState
      ? {
          ...conversation.roleplayState,
          facts: conversation.roleplayState.facts.map((fact) => ({
            ...fact,
            visibility: replaceVisibility(fact.visibility)
          }))
        }
      : undefined,
    directions: conversation.directions?.map((direction) => ({
      ...direction,
      target:
        direction.target.kind === 'speaker' && direction.target.speakerId === personaId
          ? { kind: 'speaker' as const, speakerId: detachedId }
          : direction.target
    }))
  }
}

export function visibilityAllows(
  visibility: KnowledgeVisibility,
  speakerId: string,
  mode: Conversation['knowledgeMode'] = 'scoped'
): boolean {
  return mode === 'public-only' ||
    visibility.kind === 'public' ||
    visibility.characterIds.includes(speakerId)
}

export function messageContentForSpeaker(
  message: ChatMessage,
  speakerId: string,
  mode: Conversation['knowledgeMode'] = 'scoped'
): string {
  if (!message.segments?.length) return message.content
  return message.segments
    .filter((segment) => visibilityAllows(segment.visibility, speakerId, mode))
    .map((segment) => segment.content.trim())
    .filter(Boolean)
    .join('\n')
}

export function activeDirectionsForSpeaker(
  directions: SceneDirection[] | undefined,
  speakerId: string
): SceneDirection[] {
  return (directions ?? []).filter(
    (direction) =>
      direction.enabled &&
      !direction.resolvedAt &&
      !direction.consumedAt &&
      (direction.target.kind === 'cast' || direction.target.speakerId === speakerId)
  )
}

export function consumeOneShotDirections(
  directions: SceneDirection[] | undefined,
  speakerId: string,
  messageId: string,
  consumedAt: string
): SceneDirection[] | undefined {
  if (!directions) return undefined
  return directions.map((direction) =>
    direction.scope === 'next-beat' &&
    direction.enabled &&
    !direction.consumedAt &&
    (direction.target.kind === 'cast' || direction.target.speakerId === speakerId)
      ? { ...direction, consumedAt, consumedByMessageId: messageId }
      : direction
  )
}

export function personaPromptForSpeaker(
  speaker: Persona,
  cast: Persona[]
): string {
  const lines: string[] = []
  let budget = PERSONA_PROMPT_BUDGET_CHARS
  const publicDescription = clip(speaker.publicDescription, budget)
  if (publicDescription) {
    lines.push(`Public identity: ${publicDescription}`)
    budget -= publicDescription.length + 18
  }
  budget = appendBudgeted(lines, 'Private motivation', speaker.privateMotivations, budget)
  budget = appendBudgeted(lines, 'Secret', speaker.secrets, budget)
  budget = appendBudgeted(lines, 'Constraint', speaker.behavioralConstraints, budget)
  const speech = clip(speaker.speechGuidance, budget - 18)
  if (speech) lines.push(`Speech guidance: ${speech}`)

  let relationshipBudget = RELATIONSHIP_PROMPT_BUDGET_CHARS
  for (const relationship of speaker.relationships ?? []) {
    const other = cast.find((persona) => persona.id === relationship.personaId)
    if (!other) continue
    const prefix = `- ${other.name}: `
    const summary = clip(relationship.summary, relationshipBudget - prefix.length)
    if (!summary) break
    lines.push(`${prefix}${summary}`)
    relationshipBudget -= prefix.length + summary.length + 1
  }
  return lines.join('\n')
}

export function publicCastDescription(persona: Persona): string {
  return persona.publicDescription?.trim() || persona.role?.trim()
}

export function publicRelationshipPrompt(cast: Persona[]): string {
  let budget = RELATIONSHIP_PROMPT_BUDGET_CHARS
  const lines: string[] = []
  for (const owner of cast) {
    for (const relationship of owner.relationships ?? []) {
      if (relationship.visibility !== 'public') continue
      const other = cast.find((persona) => persona.id === relationship.personaId)
      if (!other) continue
      const prefix = `- ${owner.name} → ${other.name}: `
      const summary = clip(relationship.summary, budget - prefix.length)
      if (!summary) return lines.join('\n')
      lines.push(`${prefix}${summary}`)
      budget -= prefix.length + summary.length + 1
    }
  }
  return lines.join('\n')
}

export function roleplayStatePrompt(
  conversation: Pick<Conversation, 'roleplayState' | 'knowledgeMode'>,
  speakerId: string,
  includeRecap = true
): string {
  const state = conversation.roleplayState
  if (!state) return ''
  const lines: string[] = []
  let budget = ROLEPLAY_STATE_PROMPT_BUDGET_CHARS
  const recap = includeRecap ? clip(state.recap, budget) : ''
  if (recap) {
    lines.push(`Continuity recap: ${recap}`)
    budget -= recap.length + 20
  }
  for (const fact of state.facts) {
    if (!visibilityAllows(fact.visibility, speakerId, conversation.knowledgeMode)) continue
    const prefix = `- [${fact.category}] `
    const text = clip(fact.text, budget - prefix.length)
    if (!text) break
    lines.push(`${prefix}${text}`)
    budget -= prefix.length + text.length + 1
  }
  return lines.join('\n')
}

export function directionPrompt(directions: SceneDirection[]): string {
  let budget = DIRECTION_PROMPT_BUDGET_CHARS
  const lines: string[] = []
  for (const direction of directions) {
    const text = clip(direction.content, budget - 2)
    if (!text) break
    lines.push(`- ${text}`)
    budget -= text.length + 3
  }
  return lines.join('\n')
}

/** User corrections never overwrite pinned facts; an explicit matching id is required. */
export function upsertRoleplayFact(facts: RoleplayFact[], fact: RoleplayFact): RoleplayFact[] {
  const existing = facts.find((item) => item.id === fact.id)
  if (existing?.pinned && !fact.userAuthored) return facts
  return existing
    ? facts.map((item) => (item.id === fact.id ? fact : item))
    : [...facts, fact]
}
