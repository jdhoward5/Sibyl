# Local model hardware-fit advisor

Sibyl shows memory-fit guidance in model search results, download file details,
and the installed library. The calculation stays local and uses:

- GGUF file size and parsed parameter label;
- configured context window and GPU-layer policy;
- current free/total system memory reported by the OS;
- measured free/total VRAM from the inference backend.

The Models page detects the CPU, logical cores, operating system, architecture,
GPU devices, backend, and memory before any model is loaded. The hardware probe
runs in the engine lifecycle queue and reuses a loaded model's backend; it never
allocates a model or context. Refresh updates the snapshot. Detection failures
leave CPU/RAM visible and mark missing GPU capacity as unknown.

Search cards use a labeled Q4 preview based on the parameter count in the model
name, assuming roughly 0.65 bytes per parameter. Common `8x7B` expert counts are
multiplied for this approximation. Names without a parameter count stay unknown
until file details are opened. Download rows use actual complete file sizes,
including every shard; missing sizes or incomplete shard sets stay unknown.

Browsing compares estimated requirements to total capacity, reserving 20% of
RAM (at least 4 GiB) and 10% of GPU capacity (at least 0.5 GiB). This keeps the
recommendation stable when another model is loaded. The recommended parameter
tier and Q4_K_M suggestions use the same calculation and current load settings.
On unified-memory devices, all weights count against shared system RAM; GPU
usage is part of that pool, not additional capacity to add to it.

The estimate includes mapped weights, allocator headroom, an architecture-based
KV-cache range, and partial/full offload. It labels a configuration
`comfortable`, `tight`, `infeasible`, or `unknown` (shown as Likely fits, Tight
fit, Over budget, or Fit unknown). Auto offload previews assume full GPU offload;
partial CPU offload may permit larger models at lower speed. The existing load
preflight uses currently available memory. A clearly infeasible load
requires an explicit “try anyway” confirmation, but Sibyl never prevents the
override.

This is deliberately a range, not a promise. GGUF metadata available in the
registry does not fully describe layer count, embedding width, grouped-query
attention, driver reservations, backend scratch buffers, or memory shared with
other applications. OS free RAM may exclude reclaimable caches. Fit is a memory
estimate, not a compatibility check or throughput benchmark.

No benchmark or hardware inventory is uploaded. Measured engine status and
estimated requirements are visually distinguished.

