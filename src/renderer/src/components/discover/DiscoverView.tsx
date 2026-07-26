import { useEffect } from 'react'
import { actions, useStore, type SortKey } from '../../store'
import { ModelCard } from './ModelCard'
import { ModelDetailDrawer } from './ModelDetailDrawer'
import { SearchIcon } from '../../lib/icons'

const sorts: { key: SortKey; label: string }[] = [
  { key: 'trending', label: 'Trending' },
  { key: 'downloads', label: 'Most downloaded' },
  { key: 'likes', label: 'Most liked' }
]

export function DiscoverView({ embedded = false }: { embedded?: boolean }) {
  const { query, sort, results, loading, error } = useStore((s) => s.discover)

  // Initial load of trending models.
  useEffect(() => {
    if (results.length === 0 && !loading) void actions.search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`border-b border-sibyl-border/60 px-8 ${embedded ? 'py-4' : 'py-5'}`}>
        {!embedded && <div className="eyebrow mb-3 text-sibyl-accent">Hugging Face</div>}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sibyl-muted" />
            <input
              value={query}
              onChange={(e) => actions.setDiscoverQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && actions.search()}
              placeholder="Search models — e.g. roleplay, Llama, Qwen…"
              className="input h-[44px] pl-10"
            />
          </div>
          <button onClick={() => actions.search()} className="btn-primary h-[44px]">
            Search
          </button>
        </div>
        <div className="mt-3 flex gap-1.5">
          {sorts.map((s) => (
            <button
              key={s.key}
              onClick={() => actions.setDiscoverSort(s.key)}
              className={`rounded-md px-3 py-1.5 font-mono text-[11.5px] transition-colors ${
                sort === s.key
                  ? 'border border-sibyl-accent/35 bg-sibyl-accent/10 text-sibyl-accent'
                  : 'border border-sibyl-border text-sibyl-secondary hover:text-sibyl-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            {error}
          </div>
        )}
        {loading ? (
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-[84px] rounded-lg" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sibyl-muted">
            <SearchIcon size={32} className="mb-3 opacity-40" />
            <p className="text-[14px]">No models found. Try another search.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {results.map((m) => (
              <ModelCard key={m.id} model={m} onClick={() => actions.openModelDetail(m.id)} />
            ))}
          </div>
        )}
      </div>

      <ModelDetailDrawer />
    </div>
  )
}
