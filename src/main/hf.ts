import type { HFGGUFFile, HFModelDetail, HFModelSummary } from '@shared/types'
import { isMultipartGGUF, parseQuant } from '@shared/format'
import { getSettings } from './store'

const HF_API = 'https://huggingface.co/api'
const UA = 'Oracle/0.1 (+https://github.com/oracle-app)'

async function hfHeaders(): Promise<Record<string, string>> {
  const { hfToken } = await getSettings()
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' }
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`
  return headers
}

async function hfFetch(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, { headers: await hfHeaders(), signal: controller.signal })
    if (!res.ok) {
      throw new Error(`Hugging Face API ${res.status} ${res.statusText}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

interface RawModel {
  id?: string
  modelId?: string
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
 * Search Hugging Face for GGUF text-generation models. We always constrain to
 * the `gguf` library so every result is loadable by the local engine, and to
 * `text-generation` so we surface chat/instruct models rather than embeddings,
 * rerankers, etc.
 */
export async function searchModels(query: string, sort: SortKey = 'trending'): Promise<HFModelSummary[]> {
  const params = new URLSearchParams()
  params.set('filter', 'gguf')
  params.append('filter', 'text-generation')
  if (query.trim()) params.set('search', query.trim())
  params.set('limit', '40')
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
  return data.map(toSummary)
}

interface TreeEntry {
  type: 'file' | 'directory'
  path: string
  size?: number
  /** `oid` is the file's SHA-256 (hex) for LFS-tracked files like GGUFs. */
  lfs?: { size?: number; oid?: string }
}

/** Fetch the GGUF files for a repo with their sizes via the tree API. */
async function fetchGGUFFiles(repoId: string): Promise<HFGGUFFile[]> {
  const url = `${HF_API}/models/${repoId}/tree/main?recursive=true`
  let entries: TreeEntry[]
  try {
    entries = (await hfFetch(url)) as TreeEntry[]
  } catch {
    entries = []
  }
  if (!Array.isArray(entries)) return []
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

/**
 * Map of GGUF **basename → lowercase SHA-256** for a repo, from HF's published
 * LFS checksums. Used to verify downloads. Returns an empty map on any failure
 * (network/parse/missing) so callers degrade gracefully to size-only checks
 * rather than blocking a finished download on a flaky metadata call.
 */
export async function getFileChecksums(repoId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const url = `${HF_API}/models/${repoId}/tree/main?recursive=true`
  let entries: TreeEntry[]
  try {
    entries = (await hfFetch(url)) as TreeEntry[]
  } catch {
    return map
  }
  if (!Array.isArray(entries)) return map
  for (const e of entries) {
    const oid = e.lfs?.oid
    if (e.type !== 'file' || !oid || !e.path.toLowerCase().endsWith('.gguf')) continue
    const base = e.path.split('/').pop()
    if (base) map.set(base, oid.toLowerCase())
  }
  return map
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
