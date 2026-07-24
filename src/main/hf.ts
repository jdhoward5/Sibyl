import type { HFGGUFFile, HFModelDetail, HFModelSummary } from '@shared/types'
import { isMultipartGGUF, parseQuant } from '@shared/format'
import { getSettings } from './store'

const HF_API = 'https://huggingface.co/api'
const UA = 'Sibyl/0.1 (+https://github.com/sibyl-app)'

async function hfHeaders(): Promise<Record<string, string>> {
  const { hfToken } = await getSettings()
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' }
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`
  return headers
}

const HF_MAX_ATTEMPTS = 3

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Backoff before the next attempt; honors a numeric `Retry-After` when present. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 15_000)
  }
  return 500 * 2 ** (attempt - 1) + Math.random() * 250 // 0.5s, 1s, 2s (+ jitter)
}

/**
 * Fetch JSON from the HF API with a per-attempt 20s timeout and bounded retry.
 * Retries transient failures (network errors, timeouts, 429, 5xx) with
 * exponential backoff + jitter; fails fast on other 4xx (e.g. 401/404).
 */
async function hfFetch(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let res: Response
    try {
      res = await fetch(url, { headers: await hfHeaders(), signal: controller.signal })
    } catch (err) {
      clearTimeout(timeout)
      if (attempt >= HF_MAX_ATTEMPTS) throw err // network error / timeout
      await delay(backoffMs(attempt, null))
      continue
    }
    clearTimeout(timeout)
    if (res.ok) return res.json()
    const retriable = res.status === 429 || res.status >= 500
    if (!retriable || attempt >= HF_MAX_ATTEMPTS) {
      throw new Error(`Hugging Face API ${res.status} ${res.statusText}`)
    }
    await delay(backoffMs(attempt, res.headers.get('retry-after')))
  }
}

interface RawModel {
  id?: string
  modelId?: string
  /** Commit sha of the repo's default branch (usable as a tree revision). */
  sha?: string
  author?: string
  downloads?: number
  likes?: number
  lastModified?: string
  createdAt?: string
  tags?: string[]
  pipeline_tag?: string
  gated?: boolean | string
  siblings?: { rfilename: string }[]
  cardData?: { license?: string }
}

function toSummary(m: RawModel): HFModelSummary {
  const id = m.id ?? m.modelId ?? ''
  return {
    id,
    author: m.author ?? id.split('/')[0] ?? '',
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    lastModified: m.lastModified ?? m.createdAt ?? '',
    tags: m.tags ?? [],
    pipelineTag: m.pipeline_tag,
    gated: Boolean(m.gated)
  }
}

export type SortKey = 'trending' | 'downloads' | 'likes'

/**
 * Pipeline tags that ship as GGUF but aren't chat/instruct text models. We hide
 * these so Discover stays focused on things the engine can actually chat with,
 * while still surfacing everything else — crucially including repos that set
 * **no** pipeline tag at all (a great many community GGUF finetunes omit it, so
 * a stricter `text-generation` filter silently dropped popular models that are
 * perfectly loadable).
 */
const NON_CHAT_PIPELINE_TAGS = new Set([
  'feature-extraction',
  'sentence-similarity',
  'text-ranking',
  'text-classification',
  'token-classification',
  'fill-mask',
  'automatic-speech-recognition',
  'text-to-speech',
  'text-to-image',
  'image-classification'
])

/**
 * Search Hugging Face for GGUF chat models. We always constrain to the `gguf`
 * library so every result has files the local engine can load, then filter out
 * the handful of non-chat task types (embeddings, rerankers, ASR, …) client-side
 * rather than via a `text-generation` server filter — the latter excludes any
 * repo whose author never set a pipeline tag, which hides many usable finetunes.
 */
export async function searchModels(query: string, sort: SortKey = 'trending'): Promise<HFModelSummary[]> {
  const params = new URLSearchParams()
  params.set('filter', 'gguf')
  if (query.trim()) params.set('search', query.trim())
  params.set('limit', '50')
  params.set('full', 'false')
  if (sort === 'downloads') {
    params.set('sort', 'downloads')
    params.set('direction', '-1')
  } else if (sort === 'likes') {
    params.set('sort', 'likes')
    params.set('direction', '-1')
  } else {
    params.set('sort', 'trendingScore')
    params.set('direction', '-1')
  }
  const data = (await hfFetch(`${HF_API}/models?${params.toString()}`)) as RawModel[]
  if (!Array.isArray(data)) return []
  return data
    .map(toSummary)
    .filter((m) => !m.pipelineTag || !NON_CHAT_PIPELINE_TAGS.has(m.pipelineTag))
}

interface TreeEntry {
  type: 'file' | 'directory'
  path: string
  size?: number
  /** `oid` is the file's SHA-256 (hex) for LFS-tracked files like GGUFs. */
  lfs?: { size?: number; oid?: string }
}

/** Resolve a repo's default-branch revision (commit sha), falling back to 'main'. */
async function resolveRevision(repoId: string): Promise<string> {
  try {
    const info = (await hfFetch(`${HF_API}/models/${repoId}`)) as RawModel
    return info?.sha || 'main'
  } catch {
    return 'main'
  }
}

/**
 * The repo file tree. Tries `main` (the near-universal default) first, then falls
 * back to the resolved default-branch revision for the rare repo whose default
 * branch is named differently. Always returns an array (empty on failure).
 */
async function fetchTree(repoId: string): Promise<TreeEntry[]> {
  try {
    const entries = (await hfFetch(`${HF_API}/models/${repoId}/tree/main?recursive=true`)) as TreeEntry[]
    if (Array.isArray(entries)) return entries
  } catch {
    /* fall through to revision resolution */
  }
  const rev = await resolveRevision(repoId)
  if (rev === 'main') return [] // already tried main
  try {
    const entries = (await hfFetch(
      `${HF_API}/models/${repoId}/tree/${rev}?recursive=true`
    )) as TreeEntry[]
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/** Fetch the GGUF files for a repo with their sizes via the tree API. */
async function fetchGGUFFiles(repoId: string): Promise<HFGGUFFile[]> {
  const entries = await fetchTree(repoId)
  return entries
    .filter((e) => e.type === 'file' && e.path.toLowerCase().endsWith('.gguf'))
    .map<HFGGUFFile>((e) => ({
      rfilename: e.path,
      size: e.lfs?.size ?? e.size,
      quant: parseQuant(e.path),
      multipart: isMultipartGGUF(e.path)
    }))
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
}

export interface RepoFileInfo {
  /** Size in bytes (LFS size when tracked, else the blob size); 0 if unknown. */
  size: number
  /** Lowercase SHA-256 for LFS-tracked files (GGUFs); absent for non-LFS files. */
  sha256?: string
}

/**
 * Map of GGUF **basename → {size, sha256}** for a repo, from HF's tree API. Used
 * to pre-flight disk space and to verify finished downloads. Returns an empty map
 * on any failure (network/parse/missing) so callers degrade gracefully — never
 * blocking a download on a flaky metadata call.
 */
export async function getRepoGgufFiles(repoId: string): Promise<Map<string, RepoFileInfo>> {
  const map = new Map<string, RepoFileInfo>()
  const entries = await fetchTree(repoId)
  for (const e of entries) {
    if (e.type !== 'file' || !e.path.toLowerCase().endsWith('.gguf')) continue
    const base = e.path.split('/').pop()
    if (base) map.set(base, { size: e.lfs?.size ?? e.size ?? 0, sha256: e.lfs?.oid?.toLowerCase() })
  }
  return map
}

/**
 * Confirm an exact repository-relative GGUF path exists in the selected repo's
 * current tree. IPC calls use this before handing a filename to the downloader.
 */
export async function repoContainsGgufFile(repoId: string, filename: string): Promise<boolean> {
  const entries = await fetchTree(repoId)
  return entries.some(
    (entry) =>
      entry.type === 'file' &&
      entry.path === filename &&
      entry.path.toLowerCase().endsWith('.gguf')
  )
}

/** Fetch and lightly clean the README for display. */
async function fetchReadme(repoId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://huggingface.co/${repoId}/raw/main/README.md`, {
      headers: await hfHeaders()
    })
    if (!res.ok) return undefined
    let text = await res.text()
    // Strip YAML front-matter.
    text = text.replace(/^---[\s\S]*?---\s*/, '')
    return text.slice(0, 4000)
  } catch {
    return undefined
  }
}

export async function getModelDetail(repoId: string): Promise<HFModelDetail> {
  const [info, ggufFiles, description] = await Promise.all([
    hfFetch(`${HF_API}/models/${repoId}`) as Promise<RawModel>,
    fetchGGUFFiles(repoId),
    fetchReadme(repoId)
  ])
  return {
    ...toSummary(info),
    id: repoId,
    ggufFiles,
    description
  }
}
