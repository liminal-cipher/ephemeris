# Ephemeris 2: implementation and verification handoff

## Phase C-1 simulated synchronisation ? 29 October 2026

Baseline: clean fetched `main` at `48079ae`, following the published Phase B
integration milestone. The user authorised focused commits and a push on
29 October 2026. Deployment and real-user migration remain outside this scope.

Implemented:

- `native/sync/protocol.js`: versioned full-snapshot operations, causal parents,
  field registers, compatible Yjs merging, deletion precedence and deterministic
  unresolved conflicts with both original versions retained.
- `native/sync/store.js` and `native/vault.js`: explicit additive schema 1 to 2
  migration, stable identities, transactional outbox, per-target deliveries,
  durable retry state, incoming dependency staging and atomic cursor application.
  The existing journal and search index remain in each mutation transaction.
- `native/sync/engine.js`: bounded asynchronous orchestration, acceptance checks,
  timeouts, cancellation, resumable cursors and no remote echo IDs. Explicit call
  only; no network listeners, credentials, production transport or background sync.
- `native/sync/simulatedProvider.js`: deterministic provider with immutable IDs,
  epoch/cursor checks, exported test state, fault injection and page transforms.
- Native backup/verification now preserve schema 2 operations, delivery state,
  conflicts and checkpoints, while retaining schema 1 support. A restored copy
  must fork its client identity before being edited alongside the original.
- `native/test/sync.test.js` and `sync-worker.js`: 30 new tests with independent
  directories, reopen assertions, child-process exits and transaction failures.
  The existing Ubuntu/Windows native-test step discovers them automatically.

[ADR 0002](architecture/0002-native-sync.md) is authoritative for protocol,
reference-study findings, retained versions, recovery and current limits.
[Native Vault](native-vault.md) contains API examples and backup/rollback commands.
No AGPL implementation was copied; no new dependency was added.

Observed on Windows / Node 24.20.0, synthetic data only:

| Command | Actual result |
| --- | --- |
| `npm ci` | Passed; reported 31 moderate and 1 low dependency advisories |
| `npm run lint` | Exit 0; existing browser warnings only |
| `npm test` | 56 passed in 10 files |
| `npm run test:native` | 67 passed, including 30 sync tests; no failures/skips |
| `npm run build` | Passed; 66 offline assets; existing large-chunk warning |
| `npm run test:e2e` | 7 Chromium tests passed |
| `git diff --check` | Passed |
| Remote CI / Linux / macOS / human acceptance | Not executed for these changes |

Evidence includes two-way note edits; three-client conflict-history convergence;
English/Korean Yjs merging; concurrent rename/move fields; delete/edit/restore;
attachment collisions and checksums; duplicate/reversed pages; stale cursors;
provider loss/timeouts; overlapping sessions; upload acceptance before local ack;
process exit inside download commit; outbox/ack/inbox write failures; schema
migration rollback; backup/restore of pending operations/conflicts; legacy
retention; and read-only Companion search against a schema 2 Vault.

Testing found an FTS5 integrity callback reporting a checksum mismatch on a
long-lived connection after another connection committed, while a fresh connection
verified the same database. Opening the FTS cursor in the verification transaction
before the callback refreshed its cached view; the multi-handle regression passes.
A malformed self-parent snapshot is now rejected before conflict projection.

The principal simulated acceptance path is implemented and verified. Phase C-1
is not a production sync release. Outstanding limits:

- Cross-note cycles/deleted-parent references stop application safely; automatic
  structural recovery and a conflict-resolution API are not implemented.
- Full operation history and embedded attachments are expensive; no compaction,
  large-Vault throughput or strict memory-budget claim is made. Operation JSON
  is limited to 50 MiB including base64, potentially below native BLOB limits.
- Missing parents can remain in the durable inbox indefinitely. The waiting count
  and retained operation API expose them; there is no automatic remote reset.
- Native snapshots preserve full import archives, but sync transfers note-level
  recovery data rather than copying the complete browser import archive.
- Raw filesystem clones must not edit under the same client identity. Use
  `forkSyncClient()` on an independently edited restored copy.
- Checksums do not authenticate hostile peers. Real authenticated providers,
  resource budgets, E2EE, MCP, automatic scheduling and browser writes are absent.
- Physical power loss/disk-full, remote OS CI, and representative large-data
  recovery remain unverified; these Phase B acceptance items remain open.

Phase C-2 entry: implement explicit structural/conflict recovery, benchmark and
bound history/attachment processing, then specify authenticated durable-provider
and epoch-recovery contracts. A separately authorised transport must pass the
same fault suite plus real cross-device tests before any production claim.

## Previous browser milestone (historical)

The remaining sections describe the previous milestone. Native-storage status
and current test counts above supersede their corresponding historical entries.

27 October 2026. Baseline: `main` at `d04f14b`.
Implementation is organised into focused commits; see Git history for revisions.
No application deployment or release was performed as part of this work.

## Delivered scope

This is a substantial Phase A stabilisation slice and the beginning of Phase B,
not a completed Ephemeris 2.0 release.

- Removed startup WebRTC connections, predictable shared rooms and implicit
  public signalling/STUN defaults. Session-only settings require an explicit
  server, generated private room ID and shared secret. Disabling disconnects
  providers. Local editing does not wait for network setup.
- Introduced a React-independent `BrowserVault`, compatible append-only local
  document persistence, transaction acknowledgements, local tab propagation,
  create/update/rename/move operations, and change subscriptions.
- Added field-level metadata updates, retained deletion records, and a recovery
  panel. Deletes and restores become visible after storage commits. Concurrent
  hierarchy cycles expose a deterministic root and an explanatory message;
  original relationships remain in native backups.
- Preserved legacy source databases and every destination row. Migration is
  additive and repeatable. A migration marker and native-history checks prevent
  deliberately emptied workspaces/documents from reviving stale cache data.
- Added version 2 backups: raw workspace and page Yjs updates, legacy records,
  deleted documents, embedded image data, arbitrary metadata and selected
  presentation settings. SHA-256 detects accidental changes to the manifest.
- Added validation and additive restoration. Fresh note IDs avoid overwrites;
  parents and structured mention links are remapped. Document writes precede
  a single durable metadata publication. Original workspace metadata and legacy
  records are retained in an import archive. Old JSON array backups are accepted.
- Separated search projections from canonical content, removed editor-dependent
  save timers, and indexed restored notes before they are opened. Unknown legacy
  node types/attributes are reported instead of silently converted to blank text.
- Fixed the Graph View runtime reference, graph edge property and UUID mentions;
  backlinks now combine current metadata with the content projection.
- Removed the startup Google Fonts request. Production builds include a versioned
  service worker caching only application assets for offline reopening.
- Added Chromium tests and GitHub Actions for install, lint, unit/integration
  tests, build and browser tests. Updated compatible vulnerable dependencies.

## Architecture and decisions

See [initial assessment and plan](architecture/ephemeris-2-plan.md) and
[ADR 0001](architecture/0001-local-storage.md).

The UI reads metadata from `BrowserVault` through Zustand and edits a single
native Yjs document. `LocalDocument` writes compatible IndexedDB update records;
`noteIndex` builds a disposable Dexie projection for search, graph and backlinks.
Local tab propagation and explicitly configured WebRTC are separate transports.
Backup and restore use the same local storage boundary.

Markdown is not canonical. A future native SQLite Vault with Yjs blobs and
transactional metadata is preferred over an immediate lossy file conversion.
A local Node companion is the proposed first native/MCP integration, subject to
permission, transactional and browser API security tests. It is not implemented.

## Verification

Environment: Windows, Node 24.20.0, Chromium supplied by Playwright 1.64.1.
Test databases and browser contexts contain synthetic data only.

| Check | Result |
| --- | --- |
| Existing baseline suite | 16 tests passed |
| Clean `npm ci` followed by validation | Passed from the updated lockfile |
| Expanded unit/integration suite | 51 tests passed in 7 files |
| Chromium production-build suite | 5 tests passed |
| `npm run lint` | Exit 0; existing React/style warnings remain |
| `npm run build` | Passed; 66 offline assets; existing large-bundle warning remains |
| `git diff --check` | Passed |
| `npm audit` | 32 dependency findings remain: 31 moderate, 1 low; no high/critical findings |
| GitHub Actions execution | Not run remotely; workflow added locally |

The first browser run found an offline cache mismatch caused by `Vary: Origin`.
The corrected cache handles identical same-origin build assets across request
modes. A later restart check caught deletion acknowledgement before persistence;
destructive actions now commit before updating the view. Both regressions have
passing browser coverage. An ambiguous search locator was also corrected.

Coverage includes legacy database retention, old y-indexeddb compatibility,
repeatable migration, offline create/edit/reload/search, raw backup round trips,
unopened-note search after import, embedded image integrity, corrupt manifests,
invalid identifiers/hierarchies, source preservation on unsupported rich text,
storage failures, failed staging, tombstones, same/different-section changes,
duplicate/out-of-order updates and deletion versus concurrent modification.

Two real same-origin tabs exercise local collaboration. Independent Yjs documents
exercise conflicts through a simulated transport. A separate browser context
exercises portable export/import. These are **not** proof of real cross-device
network synchronisation, signalling authentication, NAT traversal or recovery
from a failed production remote provider. Filesystem and MCP access tests are not
applicable yet because those surfaces are not implemented. Browser process
termination during a physical disk write, OS power loss, Safari/Firefox, huge
Vaults and real user databases have not been tested.

## Data migration, backup and recovery

No destructive schema migration or purge is performed. Database names remain
`ephemeris`, `ephemeris-workspace` and `ephemeris-page-<id>`. A legacy
`NotionCloneDB` is retained. Its recovered records use `notion-<old-id>` to avoid
colliding with existing destination notes. Original legacy rich-text bytes are
retained in the native document when converted.

Use **Export** to save a version 2 JSON backup. It includes deleted content and
embedded images; it is plaintext and should be stored as private data. External
image URLs remain references, not downloaded attachments. Credentials, room IDs,
server settings and the preference that skips deletion confirmation are excluded.
Supported backup limits are 50 MiB and 10,000 document entries; larger exports
report an error without changing local data.

Use **Import** to add recovered copies. Existing pages remain untouched. Repeated
imports intentionally create additional copies, not an idempotent merge. A
restored deleted page remains in **Deleted pages** until explicitly restored.
Parent relationships and structured mentions within the imported collection are
remapped. Raw `[[title]]` links remain title-based and can be ambiguous when titles
are duplicated. Imported presentation preferences fill missing settings only;
all original imported preferences remain in the recovery archive.

If staging is interrupted, original pages are unchanged. Re-import the original
backup. Unpublished staging databases may remain; no automatic cleanup is run.
If storage reports an error, keep the browser profile and original backup; do
not clear site data. Unsupported documents remain in the source/native backup
and require an explicitly reviewed codec extension before editing.

Rollback is not a destructive database reset. Keep a current version 2 backup,
the original source databases, and the current code diff. Close all Ephemeris
tabs before changing versions. The baseline reader can read native rich text,
but does not understand metadata overlays or tombstones and cannot import the
new backup envelope. Therefore do not use the old application to edit the same
profile as a rollback procedure: it can display stale metadata/deleted pages.
Test older code in a separate disposable browser profile with synthetic data.
To recover actual work, retain this implementation and import the backup into a
separate profile first. A downgrade exporter is a remaining task.

An installed application-shell cache persists separately from IndexedDB. When
testing another build, close all tabs so the waiting worker can activate. If
necessary, unregister only the service worker via browser developer tools; do
not use “Clear site data”, which would remove notes.

## Security and remaining limits

- Fresh startup made no external requests or WebSocket connections in Chromium.
  Existing/user-selected remote covers and icons can still load their URLs;
  they are not offline assets. The optional gallery also uses remote images.
- Backups have integrity checks, not authenticated signatures or encryption.
  Do not claim E2EE. Every holder of the collaboration secret has write access;
  there is no user/role permission model, key rotation or account authentication.
- The installed Tiptap 2 family remains affected by
  [GHSA-cp6q-959q-f8rh](https://github.com/ueberdosis/tiptap/security/advisories/GHSA-cp6q-959q-f8rh).
  JSON import rejects dangerous property keys, and legacy content is checked
  against a fixed schema. These boundaries do not establish that the dependency
  is fully remediated. A coordinated Tiptap 3 upgrade and maths extension review
  are still needed; forcing an upgrade during storage repair would risk codecs.
  The nested maths dependency also retains a low-severity KaTeX advisory.
- IndexedDB remains origin/profile-bound and subject to browser eviction/quota.
  A completed transaction is acknowledged; unsaved edits and physical power-loss
  durability are not guaranteed. There is no independent filesystem Vault yet.
- Workspace and document databases cannot share a transaction. Backups capture
  per-document states, not a globally atomic instant across concurrent tabs.
  Pause collaboration and other edits when a coordinated snapshot is needed.
- Update logs, deleted content and import archives are deliberately retained.
  Compaction, retention management, large-Vault performance and memory bounds
  need further work. Indexing currently opens all live documents for the session.
- Same-field metadata conflicts still resolve through Yjs; no user-visible
  conflict history is implemented. Experimental WebRTC has no durable queue,
  bounded retry engine or remote deletion/recovery protocol.

## Remaining work, in priority order

1. Complete rich-text corpus coverage (maths, code, marks, nested lists), cross-
   browser persistence/failure tests and the Tiptap/security upgrade. Add a
   downgrade exporter and a user-facing recovery archive browser.
2. Implement the native transactional Vault through the same core API: stable
   IDs, permission checks, content/version hashes, atomic compare-and-swap,
   attachments, indexed full-text search, change journal and validated paths.
   Prove migration/restore from browser backups in an isolated native Vault.
3. Finish Joplin synchroniser/lock/delta/conflict-test source study without copying
   AGPL code. Implement a separate provider interface and deterministic simulated
   target, persistent outbox, durable tombstones, idempotency, bounded retries,
   resumable cursors and preserved conflicts. Test independent client storage.
4. Build local stdio MCP on that Vault API: read tools first, then writes with
   explicit permissions, stale-version rejection and destructive authorisation.
   Add protocol/client configuration, malformed-path and access-control tests.
5. Add deliberate Markdown import/export with explicit unsupported constructs,
   external file watching, recent-document/AI-change indicators and a dashboard.
6. Only then validate production network providers on actual independent devices.

## Exact manual verification when available

1. Use a disposable browser profile. From this repository run `npm ci`,
   `npm run build`, then `npm run preview -- --host 127.0.0.1 --port 4179`.
   Open `http://127.0.0.1:4179`. Keep the same host and port across restarts.
2. Open developer tools Network. Refresh a fresh profile and verify there are
   no requests to external hosts and no WebSocket connections. The sidebar should
   say **Local only**. Do not configure a signalling server for this test.
3. Create a page titled **Offline check**, enter body text, apply bold and add a
   nested list. Wait for **Saved locally**. After the service worker activates,
   select Offline in developer tools, reload, reopen the note and edit again.
   Restore connectivity and confirm the text is unchanged.
4. Open a second tab at the same URL. Open the same note in both. Rename in one
   tab and add body text in the other. Both should converge. This tests local
   tabs, not cross-device synchronisation.
5. Create a child page. Type `[[` in the parent and select that child to create
   a structured mention. Open **Graph View**; check the graph and navigate a
   node. Open the child and check its backlink.
6. Upload a small synthetic image as a cover/icon. Export a backup. In another
   disposable profile import the file. Check text, formatting, hierarchy, image,
   mentions and Ctrl+K body search. Import again and confirm existing notes were
   preserved and additional copies appeared.
7. Delete a test page, reload immediately after it disappears, and confirm it
   stays deleted. Expand **Deleted pages**, restore it and verify its body.
8. Corrupt a copy of the exported JSON and try importing it. Confirm rejection
   and that existing notes remain unchanged. Keep the original backup intact.
9. Automated reproduction: `npm test`, `npm run lint`, `npm run build`,
   `npx playwright install chromium`, `npm run test:e2e`. CI additionally installs
   Chromium OS dependencies on Linux. Human acceptance remains outstanding.
