import type {
  Conversation,
  InstalledModel,
  KnowledgeVisibility,
  Persona,
  RendererSettingsPatch
} from './types'
import {
  parseConversation,
  parsePersona,
  parseRendererSettingsPatch
} from './validation'

export const PORTABLE_BUNDLE_MAGIC = 'SIBYL_BUNDLE'
export const PORTABLE_BUNDLE_VERSION = 1

export interface PortableModelMetadata {
  sourceId: string
  repoId: string
  filename: string
  sizeBytes: number
  quant?: string
  paramLabel?: string
  trainContextLength?: number
  chatWrapper?: string
  verified?: boolean
  verifiedBy?: 'size' | 'sha256'
}

export interface PortableBundlePayload {
  schemaVersion: 1
  scope: 'conversation' | 'library'
  exportedAt: string
  conversations: Conversation[]
  personas: Persona[]
  settings: RendererSettingsPatch
  models: PortableModelMetadata[]
}

export interface PortableBundlePreview {
  token: string
  scope: PortableBundlePayload['scope']
  exportedAt: string
  conversationCount: number
  personaCount: number
  modelCount: number
  unresolvedModelCount: number
  collisionCount: number
}

export interface PreparedPortableImport {
  scope: PortableBundlePayload['scope']
  conversations: Conversation[]
  personas: Persona[]
  settings: RendererSettingsPatch
  unresolvedModelCount: number
  collisionCount: number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields.`)
  }
}

function allowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} contains unexpected or missing fields.`)
  }
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function optionalText(value: unknown, label: string, max = 4096): string | undefined {
  return value === undefined ? undefined : text(value, label, max)
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} is outside its supported range.`)
  }
  return value as number
}

function parseModelMetadata(value: unknown, index: number): PortableModelMetadata {
  const label = `models[${index}]`
  const model = object(value, label)
  allowedKeys(
    model,
    [
      'sourceId',
      'repoId',
      'filename',
      'sizeBytes'
    ],
    [
      'quant',
      'paramLabel',
      'trainContextLength',
      'chatWrapper',
      'verified',
      'verifiedBy'
    ],
    label
  )
  if (model.verified !== undefined && typeof model.verified !== 'boolean') {
    throw new Error(`${label}.verified is invalid.`)
  }
  if (
    model.verifiedBy !== undefined &&
    model.verifiedBy !== 'size' &&
    model.verifiedBy !== 'sha256'
  ) {
    throw new Error(`${label}.verifiedBy is invalid.`)
  }
  return {
    sourceId: text(model.sourceId, `${label}.sourceId`, 512),
    repoId: text(model.repoId, `${label}.repoId`, 512),
    filename: text(model.filename, `${label}.filename`, 1024),
    sizeBytes: integer(model.sizeBytes, `${label}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER),
    quant: optionalText(model.quant, `${label}.quant`, 100),
    paramLabel: optionalText(model.paramLabel, `${label}.paramLabel`, 100),
    trainContextLength:
      model.trainContextLength === undefined
        ? undefined
        : integer(
            model.trainContextLength,
            `${label}.trainContextLength`,
            1,
            16_777_216
          ),
    chatWrapper: optionalText(model.chatWrapper, `${label}.chatWrapper`, 200),
    verified: model.verified as boolean | undefined,
    verifiedBy: model.verifiedBy as 'size' | 'sha256' | undefined
  }
}

export function portableModelMetadata(model: InstalledModel): PortableModelMetadata {
  return {
    sourceId: model.id,
    repoId: model.repoId,
    filename: model.filename,
    sizeBytes: model.sizeBytes,
    quant: model.quant,
    paramLabel: model.paramLabel,
    trainContextLength: model.trainContextLength,
    chatWrapper: model.chatWrapper,
    verified: model.verified,
    verifiedBy: model.verifiedBy
  }
}

export function parsePortableBundlePayload(value: unknown): PortableBundlePayload {
  const payload = object(value, 'portable bundle payload')
  exactKeys(
    payload,
    [
      'schemaVersion',
      'scope',
      'exportedAt',
      'conversations',
      'personas',
      'settings',
      'models'
    ],
    'portable bundle payload'
  )
  if (payload.schemaVersion !== PORTABLE_BUNDLE_VERSION) {
    throw new Error('This Sibyl bundle version is not supported.')
  }
  if (payload.scope !== 'conversation' && payload.scope !== 'library') {
    throw new Error('The Sibyl bundle scope is invalid.')
  }
  const exportedAt = text(payload.exportedAt, 'portable bundle exportedAt', 100)
  if (!Number.isFinite(Date.parse(exportedAt))) {
    throw new Error('The Sibyl bundle export date is invalid.')
  }
  if (!Array.isArray(payload.conversations) || payload.conversations.length > 10_000) {
    throw new Error('The Sibyl bundle contains too many conversations.')
  }
  if (!Array.isArray(payload.personas) || payload.personas.length > 1_000) {
    throw new Error('The Sibyl bundle contains too many personas.')
  }
  if (!Array.isArray(payload.models) || payload.models.length > 10_000) {
    throw new Error('The Sibyl bundle contains too many model references.')
  }
  const conversations = payload.conversations.map(parseConversation)
  const personas = payload.personas.map((persona, index) =>
    parsePersona(persona, `personas[${index}]`)
  )
  if (new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length) {
    throw new Error('The Sibyl bundle contains duplicate conversation ids.')
  }
  if (new Set(personas.map((persona) => persona.id)).size !== personas.length) {
    throw new Error('The Sibyl bundle contains duplicate persona ids.')
  }
  const personaIds = new Set(personas.map((persona) => persona.id))
  for (const conversation of conversations) {
    if (
      conversation.personaId &&
      !personaIds.has(conversation.personaId) &&
      conversation.personaSnapshot?.sourcePersonaId !== conversation.personaId
    ) {
      throw new Error('The Sibyl bundle contains an unresolved conversation persona.')
    }
    const snapshotIds = new Set(
      (conversation.castSnapshots ?? []).map((snapshot) => snapshot.sourcePersonaId)
    )
    if (
      (conversation.cast ?? []).some(
        (personaId) => !personaIds.has(personaId) && !snapshotIds.has(personaId)
      )
    ) {
      throw new Error('The Sibyl bundle contains an unresolved cast persona.')
    }
  }
  if (payload.scope === 'conversation' && conversations.length !== 1) {
    throw new Error('A conversation bundle must contain exactly one conversation.')
  }
  const models = payload.models.map(parseModelMetadata)
  if (new Set(models.map((model) => model.sourceId)).size !== models.length) {
    throw new Error('The Sibyl bundle contains duplicate model references.')
  }
  return {
    schemaVersion: PORTABLE_BUNDLE_VERSION,
    scope: payload.scope,
    exportedAt,
    conversations,
    personas,
    settings: parseRendererSettingsPatch(payload.settings),
    models
  }
}

function remapVisibility(
  visibility: KnowledgeVisibility,
  personaIds: ReadonlyMap<string, string>
): KnowledgeVisibility {
  if (visibility.kind === 'public') return visibility
  return {
    kind: 'private',
    characterIds: visibility.characterIds.map((id) => personaIds.get(id) ?? id)
  }
}

function remapPersona(persona: Persona, personaIds: ReadonlyMap<string, string>): Persona {
  return parsePersona({
    ...persona,
    id: personaIds.get(persona.id) ?? persona.id,
    relationships: persona.relationships?.map((relationship) => ({
      ...relationship,
      personaId: personaIds.get(relationship.personaId) ?? relationship.personaId
    }))
  })
}

function remapConversation(
  source: Conversation,
  conversationId: string,
  personaIds: ReadonlyMap<string, string>,
  modelIds: ReadonlyMap<string, string | null>
): Conversation {
  const conversation = structuredClone(source)
  conversation.id = conversationId
  conversation.modelId = conversation.modelId
    ? (modelIds.get(conversation.modelId) ?? null)
    : null
  if (conversation.personaId) {
    conversation.personaId = personaIds.get(conversation.personaId) ?? conversation.personaId
  }
  if (conversation.cast) {
    conversation.cast = conversation.cast.map((id) => personaIds.get(id) ?? id)
  }
  if (conversation.personaSnapshot) {
    conversation.personaSnapshot.sourcePersonaId =
      personaIds.get(conversation.personaSnapshot.sourcePersonaId) ??
      conversation.personaSnapshot.sourcePersonaId
    conversation.personaSnapshot.persona = remapPersona(
      conversation.personaSnapshot.persona,
      personaIds
    )
  }
  if (conversation.castSnapshots) {
    conversation.castSnapshots = conversation.castSnapshots.map((snapshot) => ({
      ...snapshot,
      sourcePersonaId: personaIds.get(snapshot.sourcePersonaId) ?? snapshot.sourcePersonaId,
      persona: remapPersona(snapshot.persona, personaIds)
    }))
  }
  if (conversation.personaOverrides) {
    conversation.personaOverrides = conversation.personaOverrides.map((override) => ({
      ...override,
      personaId: personaIds.get(override.personaId) ?? override.personaId,
      relationships: override.relationships?.map((relationship) => ({
        ...relationship,
        personaId: personaIds.get(relationship.personaId) ?? relationship.personaId
      }))
    }))
  }
  conversation.messages = conversation.messages.map((message) => ({
    ...message,
    speakerId: message.speakerId
      ? (personaIds.get(message.speakerId) ?? message.speakerId)
      : undefined,
    segments: message.segments?.map((segment) => ({
      ...segment,
      visibility: remapVisibility(segment.visibility, personaIds)
    }))
  }))
  if (conversation.roleplayState) {
    conversation.roleplayState.facts = conversation.roleplayState.facts.map((fact) => ({
      ...fact,
      visibility: remapVisibility(fact.visibility, personaIds)
    }))
  }
  if (conversation.directions) {
    conversation.directions = conversation.directions.map((direction) => ({
      ...direction,
      target:
        direction.target.kind === 'speaker'
          ? {
              kind: 'speaker',
              speakerId:
                personaIds.get(direction.target.speakerId) ?? direction.target.speakerId
            }
          : direction.target
    }))
  }
  return parseConversation(conversation)
}

function referencedPersonaIds(payload: PortableBundlePayload): Set<string> {
  const ids = new Set(payload.personas.map((persona) => persona.id))
  const addPersona = (persona: Persona): void => {
    ids.add(persona.id)
    for (const relationship of persona.relationships ?? []) {
      ids.add(relationship.personaId)
    }
  }
  for (const persona of payload.personas) addPersona(persona)
  for (const conversation of payload.conversations) {
    if (conversation.personaId) ids.add(conversation.personaId)
    for (const id of conversation.cast ?? []) ids.add(id)
    if (conversation.personaSnapshot) {
      ids.add(conversation.personaSnapshot.sourcePersonaId)
      addPersona(conversation.personaSnapshot.persona)
    }
    for (const snapshot of conversation.castSnapshots ?? []) {
      ids.add(snapshot.sourcePersonaId)
      addPersona(snapshot.persona)
    }
    for (const override of conversation.personaOverrides ?? []) {
      ids.add(override.personaId)
      for (const relationship of override.relationships ?? []) {
        ids.add(relationship.personaId)
      }
    }
    for (const message of conversation.messages) {
      if (message.speakerId) ids.add(message.speakerId)
      for (const segment of message.segments ?? []) {
        if (segment.visibility.kind === 'private') {
          for (const id of segment.visibility.characterIds) ids.add(id)
        }
      }
    }
    for (const fact of conversation.roleplayState?.facts ?? []) {
      if (fact.visibility.kind === 'private') {
        for (const id of fact.visibility.characterIds) ids.add(id)
      }
    }
    for (const direction of conversation.directions ?? []) {
      if (direction.target.kind === 'speaker') ids.add(direction.target.speakerId)
    }
  }
  return ids
}

export function preparePortableImport(params: {
  payload: PortableBundlePayload
  existingPersonas: Persona[]
  existingConversations: Conversation[]
  installedModels: InstalledModel[]
  newId: () => string
}): PreparedPortableImport {
  const { payload, existingPersonas, existingConversations, installedModels, newId } = params
  const usedPersonaIds = new Set(existingPersonas.map((persona) => persona.id))
  const personaIds = new Map<string, string>()
  let collisionCount = 0
  for (const id of referencedPersonaIds(payload)) {
    let mapped = id
    if (usedPersonaIds.has(mapped)) {
      do mapped = newId()
      while (usedPersonaIds.has(mapped))
      collisionCount++
    }
    usedPersonaIds.add(mapped)
    personaIds.set(id, mapped)
  }

  const usedConversationIds = new Set(
    existingConversations.map((conversation) => conversation.id)
  )
  const conversationIds = new Map<string, string>()
  for (const conversation of payload.conversations) {
    let mapped = conversation.id
    if (usedConversationIds.has(mapped)) {
      do mapped = newId()
      while (usedConversationIds.has(mapped))
      collisionCount++
    }
    usedConversationIds.add(mapped)
    conversationIds.set(conversation.id, mapped)
  }

  const modelIds = new Map<string, string | null>()
  let unresolvedModelCount = 0
  for (const model of payload.models) {
    const local = installedModels.find(
      (candidate) =>
        candidate.repoId === model.repoId && candidate.filename === model.filename
    )
    modelIds.set(model.sourceId, local?.id ?? null)
    if (!local) unresolvedModelCount++
  }
  for (const conversation of payload.conversations) {
    if (conversation.modelId && !modelIds.has(conversation.modelId)) {
      modelIds.set(conversation.modelId, null)
      unresolvedModelCount++
    }
  }

  const personas = payload.personas.map((persona) => remapPersona(persona, personaIds))
  const conversations = payload.conversations.map((conversation) =>
    remapConversation(
      conversation,
      conversationIds.get(conversation.id) ?? newId(),
      personaIds,
      modelIds
    )
  )
  return {
    scope: payload.scope,
    conversations,
    personas,
    settings: payload.settings,
    unresolvedModelCount,
    collisionCount
  }
}
