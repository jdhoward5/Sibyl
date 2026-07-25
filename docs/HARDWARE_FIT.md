# Local model hardware-fit advisor

Sibyl estimates whether an installed GGUF is likely to fit before loading it.
The calculation stays local and uses:

- GGUF file size and parsed parameter label;
- configured context window and GPU-layer policy;
- current free/total system memory reported by the OS;
- live free/total VRAM when the inference backend has already initialized.

The estimate includes mapped weights, allocator headroom, an architecture-based
KV-cache range, and partial/full offload. It labels a configuration
`comfortable`, `tight`, `infeasible`, or `unknown`. A clearly infeasible load
requires an explicit “try anyway” confirmation, but Sibyl never prevents the
override.

This is deliberately a range, not a promise. GGUF metadata available in the
registry does not fully describe layer count, embedding width, grouped-query
attention, driver reservations, backend scratch buffers, or memory shared with
other applications. Before backend initialization, VRAM capacity is marked
unknown rather than invented. After a successful load, the engine’s measured
VRAM state replaces that missing resource input.

No benchmark or hardware inventory is uploaded. Measured engine status and
estimated requirements are visually distinguished.

