# Ephemeris 2 implementation assessment

Baseline: `d04f14b` (fetched `main`, 27 October 2026).

## Existing system and verified risks

React 19 / Vite 8 renders a Tiptap 2 editor. A Yjs document in
`ephemeris-workspace` holds page metadata; separate `ephemeris-page-<id>`
IndexedDB databases hold rich text. Dexie `ephemeris.pages` contains legacy
documents and a delayed JSON projection used for search and backlinks.
Zustand stores navigation and workspace view state.

- Both workspace and editor instantiate WebRTC providers on startup with
  predictable rooms and public signalling endpoints.
- Export enumerates only Dexie rows, omitting unopened new pages and raw Yjs
  state. Import overwrites rows while existing Yjs content wins on reopening.
- The legacy database migration clears the destination when it has at most
  one row and deletes the source. Empty Yjs workspaces repeatedly reimport
  deleted Dexie pages.
- Editor cache persistence requires a network provider, drops pending writes
  on navigation, and leaves a deep observer attached. Legacy restoration can
  race initial editor content and asynchronous database loading.
- Graph View references an undefined `pages`, sends `edges` instead of
  `links`, and the link parser coerces UUID mentions to numbers.
- Replacing whole metadata objects loses simultaneous edits to different
  fields. No durable deletion records or recovery UI exist.
- Google Fonts is requested on every load. User-selected remote images also
  require connectivity. No offline application-shell cache exists.
- Baseline: 16 tests pass; lint exits successfully with warnings. No CI or
  browser integration tests are present. The initial test output was delayed,
  but the run completed successfully.

## Ordered implementation

1. Preserve existing database names and wire formats. Introduce a local
   persistence boundary with transaction acknowledgements and local tab sync.
2. Remove implicit network connections. Offer explicitly configured,
   session-only experimental collaboration with no default servers or rooms.
3. Preserve source databases and raw legacy documents. Add durable migration
   markers, per-field metadata updates and recoverable deletion records.
4. Add validated, versioned Yjs backups and additive restoration; publish
   restored metadata only after document writes complete.
5. Repair graph/backlinks and editor loading/cache behaviour. Exercise real
   editor round trips, offline restarts and independent browser clients.
6. Add CI, an ADR, recovery instructions and precise continuation evidence.

Phase B begins with the storage boundary, not a claim of a complete desktop
Vault. Transactional native storage, filesystem imports, durable remote sync,
MCP and the broader dashboard follow once this browser foundation is verified.

## Reference study and licence boundary

Joplin's [architecture](https://joplinapp.org/help/dev/spec/architecture/)
separates shared services and models from its UI and local SQLite database.
Its [sync specification](https://joplinapp.org/help/dev/spec/sync/)
describes target adapters, per-item sync metadata and an in-memory target for
tests. These inform the separation and future deterministic test approach.
No Joplin implementation is copied. Detailed synchroniser, locking and conflict
test source review remains required before Phase C.

Yjs [update documentation](https://docs.yjs.dev/api/document-updates)
describes idempotent, order-independent binary updates. That supports preserving
native updates in backups; it does not prove application-level deletion,
permissions or cross-device synchronisation correctness.
