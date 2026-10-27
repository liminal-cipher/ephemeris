# ADR 0001: Preserve native documents behind a local storage boundary

Status: accepted for browser stabilisation; native backend is a proposed next step.

## Decision

Retain Yjs rich text as canonical. Keep existing IndexedDB database names and
append-only update records readable by the previous y-indexeddb implementation.
Use an independent storage module for local persistence and workspace changes;
React consumes this module. Dexie content is a rebuildable query projection,
never a second editable source after a note has been initialised. Preserve raw
legacy content and original databases for recovery.

Use field-level metadata patches over the existing page map, avoiding a
destructive conversion of existing records. Tombstones hide deleted pages
without erasing their document databases. Local BroadcastChannel communication
is separate from explicitly enabled WebRTC collaboration.

Backups include native document updates, workspace metadata, legacy rows and
selected presentation settings. Restore is additive, with fresh identities
and remapped internal links; it does not overwrite current notes. No credentials
or network settings belong in portable backups.

## Alternatives

| Option | Safety and interoperability | Complexity / decision |
| --- | --- | --- |
| Canonical Markdown files | Easy external editing; stable IDs and attachments need a manifest. Rich text, mentions and maths need an explicit lossless codec. Atomic multi-file updates need a journal. | Reject as an immediate migration; provide an explicit export format later. |
| SQLite with native Yjs blobs and transactional metadata | Atomic writes, indexes, change journal and attachment references; Markdown remains a projection. | Preferred native Vault direction, subject to integration tests. |
| IndexedDB plus native Yjs updates | Preserves current users and browser operation. Transactions cannot span separate databases; browser eviction and origin changes remain risks. | Implement now; use staged additive restore and portable backups. |

For native integration, a local Node companion is the preferred prototype:
it reuses JavaScript/Yjs and can host stdio MCP without bundling a new desktop
UI. It must own a single transactional SQLite Vault, expose a scoped local API,
and enforce origin/token checks before browser access. Tauri offers a smaller
desktop shell but adds a Rust boundary; Electron shares the runtime but adds a
large distribution and patching surface. Neither shell solves storage safety.
No companion, SQLite migration or filesystem access is enabled in this slice.

## Consequences

No destructive schema migration is required. Rich constructs and embedded
attachments survive raw backup. Remote image URLs are references, not offline
attachments. Same-field metadata races still use Yjs conflict resolution;
field-level updates protect independent fields only. Browser backups are a
collection of document snapshots, not a transaction across the whole workspace.
Old application versions do not understand new field overlays and tombstones;
rollback must preserve a current backup and original databases.
