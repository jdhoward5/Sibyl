import type { HFGGUFFile } from './types'

/** A multipart GGUF is one model, addressed by its first shard. */
export function ggufShardFilenames(filename: string): string[] {
  const match = filename.match(/^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i)
  if (!match) return [filename]
  const part = Number(match[2])
  const count = Number(match[3])
  if (part < 1 || count < part) return [filename]
  return Array.from(
    { length: count },
    (_, index) => `${match[1]}-${String(index + 1).padStart(5, '0')}-of-${match[3]}${match[4]}`
  )
}

export function canonicalGgufFilename(filename: string): string {
  const match = filename.match(/^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i)
  if (!match || Number(match[2]) < 1 || Number(match[3]) < Number(match[2])) return filename
  return `${match[1]}-00001-of-${match[3]}${match[4]}`
}

export interface GgufDownloadGroup extends HFGGUFFile {
  shardCount: number
  complete: boolean
}

/** Group complete repository-relative shard sets and report their total size. */
export function groupGgufFiles(files: HFGGUFFile[]): GgufDownloadGroup[] {
  const byName = new Map(files.map((file) => [file.rfilename, file]))
  const groups = new Map<string, GgufDownloadGroup>()
  for (const file of files) {
    const canonical = canonicalGgufFilename(file.rfilename)
    if (groups.has(canonical)) continue
    const names = ggufShardFilenames(canonical)
    const members = names.map((name) => byName.get(name))
    const complete = members.every(Boolean)
    const knownSize = complete && members.every((member) => (member?.size ?? 0) > 0)
    groups.set(canonical, {
      ...file,
      rfilename: canonical,
      size: knownSize ? members.reduce((sum, member) => sum + member!.size!, 0) : undefined,
      multipart: names.length > 1,
      shardCount: names.length,
      complete
    })
  }
  return [...groups.values()]
}
