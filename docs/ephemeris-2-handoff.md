# Ephemeris 2: implementation and verification handoff

## Autonomous expansion: 7 November 2026

This section supersedes current-state claims in the historical sections below.
The starting worktree was clean `main`, equal to fetched `origin/main` at
`03c8e5bfc0b5a6d4d0aecd901e38882183e39841`, with one worktree. Published shared
engineering instructions and available skills were inspected. No other worktree,
actual user Vault, private browser profile or real credentials were used.
Previous commits `7e7b0a1`, `d92b76e` and `03c8e5b` had separate publication
approval. After local verification, the user separately authorised semantic
commits and a push of this expansion to `main`. Deployment, releases and signing
remain outside scope. The verification table below records pre-publication local
results; subsequent runner results are available from the published commit's CI.

### Implemented and usable

- Explicit native editing with a separate, at-most-15-minute scoped Companion
  session: create/open/title/body/move/trash/restore/attachments. SQLite Yjs stays
  canonical, BrowserVault stays independent, unsupported structures remain intact
  and are refused by the rich-text editor. Optimistic version/hash checks reject
  stale writes. Selection and undo/redo survive saves within the active editor.
- Strict IndexedDB pending-write journal, per-tab recovery, lost-acknowledgement
  checking, reload/reconnect recovery, conflict comparison and a separate recovered
  text/properties copy. Attachments remain on the original. Actual Chromium process
  termination exposed localStorage write loss; replacing it with strict transactions
  passed kill/relaunch/recover/save. Storage failure stops edits and requires export
  before leaving. This is not proof against physical power loss or browser eviction.
- Quick Capture/Inbox, local-date Daily Notes with stable IDs, dated meeting
  templates, typed tags/status/project/due date/favourite properties. Table, card
  and Kanban views filter/sort the same notes; saved definitions are Vault metadata.
  Boards explicitly group only their current page. Local layout/filter preferences
  survive panel reopening. Native Ctrl/⌘+K no longer opens the browser palette;
  focus stays in the native modal. Keyboard save, undo/redo and Escape are supported.
- Seven read-only local MCP tools with explicit Vault/tool permissions, bounded
  requests/results and pagination. Real stdio subprocess tests cover negotiation,
  Korean text, links/tasks, metadata limits and rejection of arbitrary file/SQL
  requests. No cloud calls or write tools were added. Consuming agents can still
  forward tool results to an external model and must obtain the user's consent.
- Measured native query improvements over 3,000 synthetic notes and a 256-level
  hierarchy. Search median changed from 4,010.67 ms to 30.12 ms; recent-view median
  from 268.85 ms to 21.87 ms. Initial timing partly overlapped browser tests, so
  this is not a controlled speedup ratio. An 8 MiB attachment survived verified
  backup/restore and subsequent editing; details are in [measurements](sync-benchmarks.md).

### Compatibility and security evidence

The logs of [run 42231015207](https://github.com/liminal-cipher/ephemeris/actions/runs/42231015207)
showed Windows/Ubuntu success and macOS native tests failing 19 of 121 cases.
macOS 26.7.2 used an aliased temporary path: `/var` resolves through `/private/var`.
Production `directoryPath()` correctly rejects symlink ancestors. The old fixture
passed the alias directly and failed before exercising storage behaviour.
Injecting an aliased temporary root reproduced the exact error on Windows.
Only the trusted fixture root now uses `realpathSync(tmpdir())`; production
`native/paths.js` is unchanged. Positive canonical-root and negative untrusted
traversal tests pass, including an actual child test process (with inherited
`NODE_TEST_CONTEXT` removed so it does not silently skip the fixture).
Other native temporary-root fixtures and path/filename assumptions were inspected;
attachments use validated IDs rather than user-supplied filesystem paths.
At local verification, the changed code had not run on macOS or Linux. The
expanded CI matrix runs after publication; Windows results alone do not establish
that the macOS runner failure is fixed.

The initial current audit reported 31 moderate and one low advisory. All Tiptap
packages moved to 3.33.0, collaboration-caret replaced collaboration-cursor, maths
extension moved to 1.4.0 and its nested KaTeX uses the application's version.
The [Tiptap advisory](https://github.com/ueberdosis/tiptap/security/advisories/GHSA-cp6q-959q-f8rh)
and [v3 migration guide](https://tiptap.dev/docs/guides/upgrade-tiptap-v2) informed
the change. The regenerated lock also refreshed other already-allowed ranges,
including React 19.3.1, Vite 8.3.6, Playwright 1.65.0 and Yjs 13.6.33; this was not
a Tiptap-only lock change. `npm ci` succeeds; `npm audit --json` reports zero.
No force audit fix or legacy-peer-dependency bypass was used. Tests preserve
Korean text, bold/maths attributes and opaque Yjs metadata and reject malicious
JSON attributes. Audit success is not a general security certification.

Writes remain IPv4-loopback-only, require exact Host/Origin, bearer credentials,
JSON bodies, bounded payloads, independent Worker permission checks and versions.
Old read-only credentials remain read-only. Native uploads are capped at 4 MiB;
editing admits at most 1 MiB Base64 documents and 2 MiB recovery records. Credentials
are memory-only in the browser. No provider duplication, history deletion,
arbitrary plugin execution or unexpected external request was introduced.

### Verification

Windows x64 / Node 24.20.0, disposable synthetic data only:

| Command / acceptance | Result |
| --- | --- |
| `npm test` | 65 tests passed in 13 files |
| `npm run test:native` | 132 passed; zero failures/skips/TODOs, 22.3 seconds; includes real TCP/provider interruption and two real MCP subprocess tests |
| `npm run test:e2e` | Final combined run: 31 passed in 1.8 minutes; Chromium 11, Firefox 10, WebKit 10 |
| `npm run build` | Passed, 65 offline assets; existing large-chunk warning remains (main JS approximately 1.74 MB / 551 kB gzip) |
| `npm run lint` | Exit 0; inherited browser warnings remain; new native implementation passes focused lint |
| `npm audit --json` | Zero reported advisories |
| Focused `npx oxlint` and `git diff --check` | Passed without output |
| `node native/benchmark-workspace.js` | Completed; exact attachment and restored editing verified; peak RSS 169,708 KiB |
| Actual macOS / Linux execution of this revision | NOT RUN; prior baseline CI is not evidence for these changes |
| Shipping Safari, physical OS Korean IME, physical power loss, human acceptance | NOT RUN |

Playwright runs the real built application with isolated contexts, local TCP
Companions and disposable Vaults. Browser flows cover offline editing/search,
two-tab convergence, JSON export/import into another context, trash/restore and
default no-external-network startup. Native flows cover Korean/English input,
synthetic composition events, save/rename/move/undo/redo, exact attachment download,
refresh, scoped connection, errors/offline, retained drafts, stale-write conflict,
comparison/copy, daily workflows and saved views. Healthy native flows assert
no console errors, page errors, failed requests or external connections; negative
flows deliberately stop the Companion. Desktop and 420-pixel layouts, dark/light
themes and modal focus are checked. WebKit is engine coverage, not shipping Safari.
The Chromium-only crash test owns and kills its own isolated browser process tree.

Screenshots are generated under `test-results/` by the tests and are inspected,
including desktop/narrow/dark editing, conflict, board and crash recovery. A test
rerun replaces this generated directory. Failure traces are retained only on
failure; passing screenshots are not invented manual acceptance evidence.

The final run retains 20 PNGs and no failure trace. Representative local paths:

- `test-results/native-edit-native-note-li-6056e-resh-and-responsive-editing-chromium/native-edit-desktop.png`
- `test-results/native-edit-native-note-li-6056e-resh-and-responsive-editing-webkit/native-edit-dark.png`
- `test-results/native-edit-offline-pendin-f1744--destructive-recovered-copy-chromium/native-conflict.png`
- `test-results/native-edit-capture-daily--da2a7--views-share-the-same-Vault-chromium/native-board-cards.png`
- `test-results/native-crash-forced-Chromi-f9750-raft-in-an-isolated-profile-chromium/native-crash-recovered.png`

Initial failures were investigated, not hidden by automatic retries: the pending
journal lost data on a real crash, a background global shortcut stole native
focus, undo grouping crossed a save boundary, and a late query replaced typed
filters. All were corrected and rerun. A WebKit test also attempted file selection
while the control was disabled; `setInputFiles` bypasses actionability, so the test
now waits for the move's UI acknowledgement. That flow passed three consecutive
WebKit runs before the final combined pass. Known dependency-resolution scratch
was inspected and recycled; normal test teardown removed managed fixtures and
the owned crash browser was confirmed stopped. Screenshots remain as deliverables.

### Changed files

| Area | Exact paths |
| --- | --- |
| Path regression | `native/test/vault.test.js`, `native/test/paths.test.js` |
| Scoped Companion | `native/companion.js`, `native/companion-worker.js`, `native/companion-operations.js`, `native/serve.js`, `native/test/companion-write.test.js` |
| Canonical queries | `native/vault.js`, `native/knowledge.js`, `native/test/knowledge.test.js`, `native/test/search.test.js`, `native/benchmark-workspace.js` |
| Native editing/recovery | `src/storage/nativeConnection.js`, `src/storage/nativeDocument.js`, `src/storage/nativeDraftJournal.js`, `src/storage/nativeDocument.test.js`, `src/components/NativeWorkspace.jsx`, `src/components/NativeWorkspace.css`, `src/components/NativeNoteEditor.jsx`, `src/App.jsx` |
| Daily workflows/views | `src/storage/nativeTemplates.js`, `src/components/NativeViews.jsx`, `src/components/NativeViews.test.jsx` |
| MCP | `native/mcp.js`, `native/mcp-tools.js`, `native/test/mcp.test.js` |
| Editor upgrade | `package.json`, `package-lock.json`, `src/components/PageEditor.jsx`, `src/components/editor/EditorToolbar.jsx`, `src/storage/noteContent.js`, `src/storage/editorCompatibility.test.js` |
| Browser acceptance/CI | `e2e/workspace.spec.js`, `e2e/native-edit.spec.js`, `e2e/native-crash.spec.js`, `playwright.config.js`, `.github/workflows/ci.yml` |
| Documentation | `README.md`, `PLAN.md`, `DECISIONS.md`, `docs/native-vault.md`, `docs/sync-benchmarks.md`, `docs/ephemeris-2-handoff.md`; ignored local `CURRENT_TASK.md` |

### Use, migration and remaining work

Follow the [native guide](native-vault.md#explicit-native-editing-and-recovery) for
an explicit `--edit` Companion session and the MCP command. Start with a synthetic
or backed-up copy. The existing [BrowserVault migration](native-vault.md#isolated-migration-and-recovery)
requires an explicit v2 JSON export and a new empty Native Vault. Inspect the copy,
export/verify a native snapshot, restore it into another new directory and validate
editing before choosing it. Keep the original browser data and backup. To recover
pending writes, reconnect a fresh session to the same physical Vault and select
its retained draft. A restored/replaced Vault has a new recovery namespace; no
pending write is silently replayed there. Corrupt/interrupted restore directories
stay closed; restore the original verified snapshot into another new directory.

Markdown/YAML/Obsidian/Joplin import/export and round-trip migration previews were
not implemented in this iteration. Unknown rich text still needs a supported
codec/source-preservation contract before such conversion is safe. The existing
lossless JSON/native snapshot paths remain available. Full revision history and
sync conflict inbox, retry/status/identity dashboard and backup wizard still need
UI work; current editing conflicts are not the whole sync conflict model.
No tabs/splits, heading/block embeds, Canvas, clipper, OCR, semantic search or
large browser-sidebar benchmark is claimed. Native attachment editing beyond the
4 MiB UI cap, session renewal without CLI, a friendlier parent picker, continuous
offline stress acceptance and lower backup/restore latency remain practical gaps.

Electron, Tauri with Node sidecar and browser-plus-Companion trade-offs are in the
[desktop comparison](native-vault.md#desktop-distribution-decision). No runtime
bundle, installer, updater, signing, notarisation or release was added. Actual
macOS/Linux CI and hands-on Windows/macOS acceptance remain gates before everyday
private-data use. The historical Phase C and overall Ephemeris 2.0 are not marked
complete by this work.

## Chunked payloads and durable provider: 6 November 2026

Baseline: clean `main` at `cb39da5`. The user authorised sequential follow-up
implementation and local commits, explicitly prohibited pushing, and selected
a self-hosted Node/SQLite provider. No deployment or real-user Vault access was
performed. [Plan](../PLAN.md), [decisions](../DECISIONS.md) and
[provider guide](sync-provider.md) describe scope, contracts and operation.

Implemented in order:

1. Explicit schema 4/protocol 3 attachment manifests, 256 KiB content-addressed
   chunks, deduplicated storage and bounded transfer. Existing operation bytes
   and schemas 1–3 remain supported; native snapshot format 1 includes schema 4.
   Metadata edits no longer copy every attachment into history. Old attachment
   conflicts can still be resolved after upgrading without losing evidence.
2. Global operation, chunk and materialised-attachment budgets; bounded conflict
   computation; `syncRetention()` reports protected history, unresolved evidence,
   provider progress and usage. Quota failures roll back notes and checkpoints.
   Destructive compaction is deliberately not implemented: provider receipts do
   not establish that offline clients or restored/forked Vaults can lose history.
3. A real authenticated HTTP client/server, namespace isolation, persistent
   revocation, signed expiring cursors, durable SQLite acknowledgements and
   explicit epoch recovery. Request/response limits, cancellation and redirect
   rejection are enforced. CLI entry points use private external configuration.
4. Real TCP conformance, forced process termination, interrupted upload,
   `SQLITE_FULL`, replay after an older server restore, quota and corruption
   tests; the CI matrix now includes Windows/Ubuntu/macOS and the HTTP benchmark.

Verification on Windows / Node 24.20.0, synthetic data only:

| Check | Result |
| --- | --- |
| `npm run test:native` | 121 passed; no failures, skips or TODOs; final combined run 20.5 seconds |
| `npm test` | 56 passed in 10 files |
| `npm run lint` | Exit 0; existing browser warnings only |
| `npm run build` | Passed; 66 offline assets; existing chunk-size warning |
| `npm run test:e2e` | 7 Chromium tests passed |
| `npx oxlint native`, `git diff --check` | Passed |
| Real HTTP 32 MiB payload | Transfer and 10 subsequent edits passed; see current benchmark measurements |
| New remote CI / Ubuntu / macOS | NOT RUN; no push; local Linux runtime unavailable |
| Physical power loss / real volume exhaustion | NOT RUN; process termination and SQLite page-budget exhaustion tested instead |
| External TLS / independent physical devices / human acceptance | NOT RUN; local TCP and automated flows only |

The previous `cb39da5` Windows/Ubuntu run was separately inspected and succeeded:
[Validate](https://github.com/liminal-cipher/ephemeris/actions/runs/41225381287).
It is not evidence for the new changes. Dependency installation was unchanged;
the installed test/build versions matched `package-lock.json`.

Remaining operational gates are the NOT RUN rows above. The provider guide
contains the manual acceptance procedure. Schema 4 retains the existing
64 MiB/1,024-operation per-note history limit; it does not automatically delete
or archive old operations to escape that limit. Yjs document snapshots are still
inline, HTTP operations are capped at 2 MiB, and physical RSS/WAL size are not
hard-capped by logical quotas. E2EE, scheduling, MCP, browser write APIs and the
separate dependency/security upgrade remain outside this follow-up scope.

The following C-2 and browser sections are historical; this section supersedes
their current-state and remaining-transport statements.

## Phase C-2 recovery and resource safety: 1 November 2026

Baseline: fetched clean `main` at `6849de7`, including the documentation update
following C-1. The applicable engineering policy was verified. The user
authorised focused commits and a push after reviewing the local milestone.
Deployment, production transport and real-user migration remain outside scope.

Implemented:

- `native/sync/recovery.js`: explicit atomic schema 3 migration, requested
  hierarchy cache, deterministic safe tree, immutable structural evidence and
  explicit one-field conflict resolution with version/causal-head checks.
- `native/sync/protocol.js`, `store.js`, `vault.js`: synchronisable protocol 2
  resolution records carry original conflict evidence, references and forced
  field writes. Original snapshots remain immutable. Resolutions, hierarchy,
  journal, search and cursor updates share a transaction. Schema 1/2 operations
  remain supported; schema 3 is opt-in on every participating peer.
- `native/backup.js`, `integrity.js`: schema 3 verification and isolated restore,
  preserving identities and recovery records. Incomplete schemas and corrupt
  migration input are rejected; migration failure rolls back.
- `native/sync/limits.js`, `engine.js`, `simulatedProvider.js`: count/byte limits,
  bounded ready-operation draining, indexed causal dependencies, lightweight
  checkpoints, namespace binding and permanent authentication error handling.
- `native/test/recovery.test.js`, `recovery-worker.js`, `provider.test.js` and
  reusable `provider-conformance.js`: convergence, competing/stale decisions,
  close/reopen, snapshot recovery, child-process termination, transaction/index
  errors, waiting dependencies, resource limits and provider faults.
- Two reproducible benchmark scripts and the existing Windows/Ubuntu CI command
  include the new tests. No dependency, browser write API or network service was
  added. No AGPL source was copied.

[ADR 0003](architecture/0003-sync-recovery.md) defines the recovery and provider
contracts. [Native Vault](native-vault.md) contains API and migration examples;
[benchmarks](sync-benchmarks.md) records actual datasets and measured constraints.
ADR 0002 remains the schema 2/protocol 1 historical baseline.

Local verification on Windows / Node 24.20.0, synthetic data only:

| Command | Actual result |
| --- | --- |
| `npm ci` | Passed; 267 packages, 31 moderate and 1 low dependency advisories |
| `npm run lint` | Exit 0; existing browser warnings only |
| `npm test` | 56 passed in 10 files; no failures/skips |
| `npm run test:native` | 91 passed; no failures/skips |
| `npm run build` | Passed; 66 offline assets; existing large-chunk warning |
| `npm run test:e2e` | 7 Chromium tests passed; no failures/skips |
| `git diff --check` | Passed |
| Remote CI / Linux / macOS / human acceptance | Not executed for these changes |

Recovery evidence includes cross-note cycles, deleted/missing parents, delayed
causal ancestors, explicit hierarchy repair and parent restoration, same/different
concurrent resolutions, resolution/edit/deletion races, retained incompatible
Yjs versions and attachment collisions. A newly bootstrapped peer receives old
conflict provenance through resolution records. Process termination before repair
COMMIT preserves every original row. Native snapshots retain resolution state.

Resource evidence includes 2,000 notes, 1,000 repeated edits, 64 divergent writers
with 2,016 retained conflicts, a lagging second target, a 1 MiB Yjs document and a
32 MiB attachment. The latter peaked near 1 GiB RSS and its next full-snapshot
edit hit the 64 MiB per-note history budget. This is a limitation, not production
capacity evidence. The large-payload experiment exposed a Base64 regexp stack
overflow; canonical decode/re-encode validation fixes it with regression coverage.

Migration and recovery:

1. Export and verify a native backup, keeping the source Vault untouched.
2. Explicitly call `enableSync()` for schema 1, then `enableRecovery()` for schema
   2. Upgrade all peers before exchanging protocol 2 resolutions. Never manually
   change schema versions or remove operation history.
3. Inspect `syncRecovery()`, `syncConflicts(id)` and `retainedSyncOperation(id)`.
   Resolve with an explicit field choice plus the current version and heads.
   Re-read after a stale decision; do not force an overwrite.
4. Restore snapshots only into new isolated directories and verify them. Before
   editing alongside the original, call `forkSyncClient()`. Keep the original
   identity on recovery of the sole active device.
5. An older binary requires a pre-upgrade backup. Preserve current schema 3 data
   separately because rollback does not include later edits. A reached history
   limit has no automatic compaction escape hatch; keep all recovery evidence.

Remaining work before production transport:

- Stream/chunk attachment payloads and reduce full-snapshot copying. Current
  per-note budgets can block legitimate edits; total database/RSS and nonlinear
  conflict growth remain unbounded. Define safe retention for offline clients,
  multiple providers, unresolved versions and restored/forked Vaults first.
- Implement an authenticated, durable provider in a separately scoped milestone.
  Enforce tenant isolation, revocation and byte limits before network buffering;
  prove crash durability, cursor expiry and epoch disaster recovery against the
  conformance suite plus real server tests. Checksums are not authentication.
- Run and inspect Windows/Ubuntu remote CI after publication. Complete
  representative large-data, physical power-loss/disk-full and human acceptance
  work. E2EE, automatic scheduling, MCP and browser writes remain out of scope.
- Missing causal history can remain staged indefinitely. Historical structural
  observations may remain unresolved after the live condition disappears. There
  is no full resolution UI, bulk multi-field resolution or automatic remote reset.
- Native snapshots preserve full browser import archives; note sync still does
  not replicate an entire browser import archive. Dependency advisories remain.

This is a tested local recovery milestone, not completion of Phase C or proof of
real cross-device synchronisation. Historical sections below describe earlier
browser work and do not override the current status above.

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
