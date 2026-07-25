# Roleplay identity, knowledge, and memory

All structures in this document are private vault records. They are never
written to operational registries or logs.

## Forward schema

`Conversation.schemaVersion = 2` and `Persona.schemaVersion = 2` are the current
versions. Missing versions are legacy v1 and migrate forward when the encrypted
record is read. Migration is idempotent:

- ordinary persona threads receive a `PersonaSnapshot`;
- scenes receive ordered `castSnapshots`;
- knowledge mode defaults to `scoped`;
- structured state and direction collections start empty.

Persona snapshots contain the prompt-critical persona revision, including
identity, private goals, relationships, generation defaults, and voice
assignment. Prompt resolution prefers a snapshot over the live library.
Refreshing is an explicit user action.

Deleting a library persona presents the affected conversation count and three
choices:

- **Keep snapshots** retains the original source id and frozen identity.
- **Detach** rewrites every conversation-local semantic reference to a new
  opaque participant id.
- **Replace** deliberately substitutes another library persona and snapshot.

## Knowledge boundary

A legacy message without `segments` is public. New `MessageSegment` records
carry either public visibility or an allow-list of character ids. The human
view is omniscient, but model prompts are built from a deterministic projection:

1. public segments;
2. private segments whose allow-list contains the active speaker;
3. structured facts visible to the active speaker;
4. only directions active for that speaker.

`public-only` compatibility mode deliberately exposes all segments to every
speaker for small models. Exports label every segment `[Public]` or
`[Private → …]`.

Compaction summarizes public material only. Private segments promoted to
structured facts remain speaker-scoped and therefore cannot leak through the
shared prose recap.

## Structured continuity

`RoleplayState` keeps a compact prose recap plus validated facts. Each extracted
fact must reference at least one existing message id; user-authored facts may
have no provenance. User-pinned facts cannot be replaced by extracted state.
History edits prune stale provenance, preserve pinned corrections as
user-authored facts, and clear a recap whose compaction boundary no longer
exists.

After eight successful scene beats, the normal compaction path runs the
roleplay-specific maintenance prompt when enough history exists. It returns a
strict JSON recap plus at most 64 public facts. Categories, lengths, fields, and
source message IDs are validated before persistence; malformed output fails the
maintenance pass. Extracted facts merge through the pinned-fact guard. The recap
preserves time, location, objects, conditions, obligations, relationship
changes, open threads, goals, and end conditions. Autoplay then pauses for
review.

## Directions

Directions are independent records linked to their visible director note:

- lifetime: next beat, until resolved, persistent, or scene metadata;
- target: whole cast or one speaker;
- state: enabled, consumed, or resolved.

Structured director notes are not replayed as ordinary transcript turns.
One-shot directions are marked consumed only in a second durable save after the
influenced beat itself is safely persisted. If that save fails, the direction
remains active and autoplay stops rather than silently losing the instruction.

## Prompt budgets

Character identity, relationship context, structured state, and directions
have deterministic character ceilings in `src/shared/roleplay.ts`. These are
approximately 3,000, 1,000, 2,000, and 1,000 tokens respectively under the
project's conservative four-characters-per-token estimate. Truncation is
deterministic and happens before native inference.
