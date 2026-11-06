# Native Vault milestone

The local expansion starts from `main` at `03c8e5b`, 7 November 2026.
Native snapshots, indexed search, explicitly scoped browser editing, structured
views, read-only stdio MCP, chunked sync, the authenticated HTTP provider and
explicit sync conflict recovery are implemented. BrowserVault remains an
independent browser workspace. No automatic migration occurs. Phase C, desktop
delivery and overall Ephemeris 2 are not declared complete.

## Runtime and architecture

Use **Node 24.15 or newer** for `native/` and `npm run test:native`; verification
used Node 24.20.0 on Windows. The browser build retains its existing Node engine
range. Native code uses built-in `node:sqlite` and the existing Yjs dependency.
No SQLite npm dependency, React, Tiptap, DOM or IndexedDB is needed by the native
implementation. The native integration tests additionally use fake IndexedDB to
exercise a real BrowserVault export.

[Node's v24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
marks the API as Stability 1.2 (release candidate), since 24.15. `DatabaseSync`
blocks its calling thread. This is acceptable for a local companion prototype;
the companion runs all SQLite and projection work in a dedicated Worker.
Revalidate runtime upgrades. This API stability trade-off avoids another native dependency.

Each Vault is a newly created local directory containing `vault.sqlite` and
SQLite-managed sidecars. Schema version 1 uses strict tables for notes,
attachments, changes and import archives. A separate additive FTS5 table is
rebuildable and never canonical. Yjs binary state is canonical;
unsupported rich-text constructs are retained as opaque native data. Metadata
is JSON. Attachments are immutable BLOBs with SHA-256 checksums, avoiding atomicity
and traversal problems from separate attachment files. Display filenames are
metadata, never filesystem paths.

All mutations use `BEGIN IMMEDIATE` through `COMMIT`, with rollback on failure.
WAL and `synchronous=FULL` are enabled. A write acknowledgement follows COMMIT.
SQLite serialises writers; a five-second busy timeout returns an error when a
lock cannot be acquired. Every existing-note mutation requires its current
integer version and optionally its content hash. The version covers metadata,
content, deletion and attachments; the content hash covers the exact Yjs bytes.
Checking a hash alone is insufficient to protect metadata changes.

The SQL connection and transaction machinery are private. Future adapters must
call this API; no arbitrary SQL or unvalidated import entry point is exposed.
The change journal has a durable sequence, note ID, version, kind, content hash
and timestamp. Schema 2 adds an independent immutable sync outbox linked to local
journal sequences, without replacing this journal. Native writes replace a
complete validated Yjs snapshot; callers
must merge updates in a Y.Doc and submit its full state. Incomplete deltas are
rejected. The simulated sync engine merges compatible causal Yjs snapshots and
independent metadata fields; ambiguous versions remain inspectable conflicts.

## Explicit simulated synchronisation (Phase C-1)

See [ADR 0002](architecture/0002-native-sync.md) for protocol 1, causality,
transaction guarantees, recovery semantics, reference study and limitations.
The engine and provider are UI-independent modules. They create no network
listeners and are not invoked by opening a Vault or starting the browser.

```js
import { NativeVault } from './native/vault.js'
import { SimulatedProvider } from './native/sync/simulatedProvider.js'
import { synchronise } from './native/sync/engine.js'

const a = NativeVault.create('/absolute/private/new-vault-a')
const b = NativeVault.create('/absolute/private/new-vault-b')
const provider = new SimulatedProvider() // In-memory test transport only.
try {
  a.enableSync()
  b.enableSync()
  a.create({ id: 'example', metadata: { title: 'Synthetic note' } })
  await synchronise(a, provider)
  await synchronise(b, provider)
  console.log(b.read('example').metadata.title)
} finally { a.close(); b.close() }
```

Use new absolute Windows paths on Windows. Parent directories must exist.
`enableSync()` is an explicit, atomic schema 1 to 2 migration; take a native
backup first for any existing Vault. It seeds baseline operations without changing
native note bytes, versions or journals. Read-only handles cannot activate sync.

`synchronise(vault, provider, options)` publishes bounded pending operations and
downloads bounded pages. Options include an injected `now` clock, `limit` (1–100),
`maxPages` (1–1000), `timeoutMs` (1–60000) and an AbortSignal. Results report
uploaded/applied counts, dependency waiting count and whether immediate work
remains. Inspect `syncStatus(targetId)` for retry times before scheduling another
call. The caller owns scheduling and must move synchronous storage off an
interactive thread. Edits remain available while the provider is disconnected.

Storage API additions:

| API | Purpose |
| --- | --- |
| `enableSync()`, `syncIdentity()` | Explicit migration and stable Vault/client IDs |
| `connectSync(targetId, epoch)` | Bind target namespace; reject a changed epoch |
| `pendingSync(targetId, { now, limit })` | Read eligible immutable outbound operations |
| `acknowledgeSync(targetId, id, sha256)` | Idempotent matching acceptance |
| `retrySync(targetId, id, now)` | Persist bounded exponential delay |
| `receiveSync(targetId, expectedCursor, page)` | Atomically stage/apply a page and checkpoint |
| `syncStatus(targetId)` | Cursor, deliveries and dependency waiting count |
| `syncConflicts(noteId)` | Retained conflicts; schema 3 includes derived resolution status |
| `retainedSyncOperation(id)` | Complete original operation and recovery snapshot |
| `forkSyncClient()` | New client identity for an independently edited restored copy |

None of these write APIs is exposed by the read-only HTTP companion. Sync requires
trusted local invocation; operation checksums are not authentication. A remote
provider must promise durable acceptance and enforce immutable IDs. The simulator
tests the contract but does not provide real cross-device durability.

Native snapshot format 1 accepts schemas 1–4 and preserves sync state. Restore
into a new directory and verify before use. If the original remains active, call
`forkSyncClient()` on the restored copy before any new edits. The fork retains old
operation IDs and pending deliveries; it changes only the author of future edits.
An older Phase B binary must use a pre-activation schema 1 backup, never a database
whose version field has been manually downgraded. Keep post-activation snapshots
for recovering later edits; rollback to an older backup does not include them.

## Explicit conflict recovery (Phase C-2)

[ADR 0003](architecture/0003-sync-recovery.md) defines the implemented recovery
rules, protocol 2 resolution records and future provider contract. All peers
exchanging resolutions must explicitly upgrade. Opening a Vault never upgrades
it or starts synchronisation.

For an existing Vault, export and verify a native backup first. Then call
`enableSync()` if still on schema 1 and `enableRecovery()` to move schema 2 to 3.
The latter is atomic and idempotent; failure leaves the previous schema intact.
There is no in-place downgrade. To use an older binary, restore the pre-upgrade
backup into an isolated new directory; it will not contain subsequent edits.
Keep the upgraded Vault and a current native backup for recovering those edits.
Never change `user_version` manually or delete sync tables.

```js
vault.enableRecovery() // Requires explicit enableSync() first.
const id = 'example'
const conflicts = vault.syncConflicts(id)
const conflict = conflicts.find(c => c.status === 'unresolved' && c.field === 'meta:title')
if (conflict) {
  const expected = { ...vault.read(id), heads: vault.syncHeads(id) }
  // Inspect these complete original versions before making a decision.
  const originals = conflict.operations.map(op => vault.retainedSyncOperation(op))
  console.log(originals)
  vault.resolveSyncConflict(id, conflict.id, { value: 'Explicit merged title' }, expected)
  // Alternatively choose a same-note competitor: { operationId: originals[0].id }.
}
```

The API resolves one field at a time: title/metadata, parent ID, deletion state,
document (canonical Base64 full Yjs state), or an entire checksummed attachment
record. A stale version or causal-head list rejects the decision. Concurrent
different decisions create another retained conflict. Original snapshots and
attachment bytes remain accessible with `retainedSyncOperation()`; selecting a
document never converts unsupported content. Deletion `value: null` is an explicit
restore decision. Attachment collisions keep the same attachment ID; the unchosen
bytes remain in recovery history rather than appearing as a second live file.

`syncRecovery()` lists current structural problems and up to 100 waiting causal
operations. `requestedSyncNote(id)` returns the original requested snapshot.
Invalid parent edges temporarily appear at the root, with all affected IDs,
operations and reasons retained. Resolve a structural conflict with a valid
`{ value: parentId }` or `{ value: null }`. Related hierarchy/search changes commit
atomically. Missing parents and explicit parent restoration can make old edges
valid again; historical observations remain inspectable in `syncConflicts()`.

`synchronise()` additionally accepts `maxBytes` (1 KiB–64 MiB) and `namespace`.
Use `providerTargetId(info, namespace)` from `native/sync/engine.js` for the target
key when inspecting a non-default namespace. Schema 3 admits at most 1,024
operations and 64 MiB of retained operation JSON per note. Hitting a budget fails
the whole mutation; it does not delete history. Full snapshots make large
attachments expensive and can block subsequent edits. Read the actual
[benchmarks and remaining limits](sync-benchmarks.md) before capacity planning.
Sync configuration and causal conflict resolution are not exposed through the
Companion. Its separate editing permission grants only note/attachment operations.

## API

Import `NativeVault` from `native/vault.js`. Paths must be absolute, their parent
directory must already exist, and creation refuses an existing destination.
Opening refuses missing databases, unsupported schemas and detected corruption.
IDs are strings up to 200 characters, cannot contain path separators/control
characters, and cannot be reserved prototype names, `.` or `..`.

```js
import { NativeVault } from './native/vault.js'
import * as Y from 'yjs'

const vault = NativeVault.create(absoluteNewDirectory)
const doc = new Y.Doc()
try {
  doc.getText('body').insert(0, 'Local content')
  let note = vault.create({
    id: 'stable-id', // Omit to generate a UUID.
    metadata: { title: 'First note', parentId: null, tags: ['example'] },
    document: Y.encodeStateAsUpdate(doc),
  })
  note = vault.rename(note.id, 'Renamed', note)
  note = vault.update(note.id, { metadata: { tags: ['updated'] } }, note)
  note = vault.putAttachment(note.id, {
    id: 'attachment-id', bytes: new Uint8Array([1, 2, 3]),
    metadata: { name: 'example.bin', mediaType: 'application/octet-stream' },
  }, note)
  note = vault.delete(note.id, note)
  note = vault.restore(note.id, note)
} finally { doc.destroy(); vault.close() }

const reopened = NativeVault.open(absoluteNewDirectory)
try { console.log(reopened.read('stable-id').metadata.title) }
finally { reopened.close() }
```

| Method | Contract |
| --- | --- |
| `create({id?, metadata?, document?})` | Returns the committed note at version 1. |
| `read(id)` | Includes native bytes, metadata, version, hash, tombstone, recovery status and retained legacy rows. |
| `list({includeDeleted?, includeRecovery?})` | Excludes deleted/recovery-only records by default. Includes full note data. |
| `update(id, {metadata?, document?}, expected)` | Patches top-level metadata and/or replaces complete native bytes. |
| `rename(id, title, expected)` / `move(id, parentId, expected)` | Preserve ID; reject invalid parents and cycles under the write lock. |
| `delete(id, expected)` | Soft-deletes this note only; descendants and all content/attachments remain stored. |
| `restore(id, expected)` | Restores this note at the root; increments version. |
| `putAttachment(noteId, {id?, bytes, metadata?}, expected)` | Inserts an immutable attachment and increments the note version atomically. Duplicate attachment IDs fail. |
| `readAttachment(noteId, id)` / `listAttachments(noteId)` | Read checksum-verified bytes / attachment descriptors. |
| `changes({after?, limit?})` | Ordered cursor pagination, default 1,000, maximum 10,000 records. |
| `importBackup(text)` | Validate and import v2 into an empty Vault, or return a no-op for the same payload checksum. |
| `readImport(sha256)` | Original imported backup text, including workspace, settings and recovery data. |
| `exportBackup(newDirectory, {signal?})` | SQLite online snapshot with verified manifest publication. Await before closing the source handle. |
| `verify()` | SQLite, native bytes, attachment checksums, journal and archive integrity checks in a read transaction. |
| `search(query, {limit?, offset?})` | Literal substring search, stable ID ordering; limit 1–100 and offset 0–10,000. |
| `rebuildSearch()` / `verifySearch()` | Transactionally rebuild / check the disposable index without changing notes or journal. |
| `preview(id)` | Supported plain text plus explicit coverage and reasons. |
| `listPage(options)` / `recentChanges({limit?})` | Bounded live-note metadata / newest-first journal records. |
| `queryNotes(options)` | Bounded metadata views; tag, project, status and favourite filters; title, recent-change or due-date ordering. Saved definitions are ordinary Vault metadata. |
| `convertLegacy(id, expected)` | Explicit, version-checked conversion of a proven plain paragraph/text subset. |
| `close()` | Idempotently closes the connection; refuses while its backup is active. |

`expected` is `{version, contentHash?}`; passing the previously read note works.
`ConflictError` means reread and explicitly reconcile before retrying. Other
SQLite/validation errors propagate; failed operations must not be acknowledged
as saved. Parent deletion does not cascade in this API. Children keep their
original parent ID and remain listed; future tree adapters must render children
of hidden parents at a visible root. This intentionally avoids implicit subtree
deletion with unverified descendant versions.

Open with `NativeVault.open(directory, {readOnly: true})` to forbid all mutations,
including index rebuilding. A writable open adds/rebuilds the index only when
absent. The companion requires a ready index and never upgrades the selected
Vault. Use `rebuild-search` locally before connecting an older Vault.

## Browser projection correction

Regression tests confirmed both risks in the previous `pages.put` call: numeric
ID `7` produced a second string-ID row, while string ID `"7"` lost metadata.
Dexie schema version 2 adds only `searchProjection`; it neither deletes nor
rewrites `pages`. Search, graph and backlinks read the new table. Mention
suggestions use current workspace metadata, excluding deleted notes.

Existing numeric/string duplicates are retained as recovery evidence rather
than guessed away. This fix cannot reconstruct metadata already overwritten by
an earlier build. Native workspace metadata and original backups remain recovery
sources. Search is rebuilt from native documents; unsupported legacy content is
reported rather than replaced with an empty projection.

## Isolated migration and recovery

1. Export a version 2 backup from the browser. Keep the original file and browser
   profile. Pause editing while exporting if a coordinated snapshot is required.
2. Use a **new, absolute directory** beneath an existing trusted local directory:

   ```text
   node native/cli.js import path/to/backup.json C:/LocalVaults/imported-copy
   node native/cli.js inspect C:/LocalVaults/imported-copy
   ```

   On POSIX use an absolute path such as `/home/me/LocalVaults/imported-copy`.
   To create an empty Vault, use `node native/cli.js create <absolute-directory>`.
   The CLI prints counts/checksums, not document contents, and closes the Vault.
3. Inspect the separate native copy through Native workspace, export a native
   backup, restore it into another new directory, and verify subsequent editing
   there before choosing the imported Vault for daily use. Unsupported documents
   remain readable as projections/downloads and cannot be forced into the editor.
   Keep the original browser profile and backup; the application never switches
   or migrates that workspace automatically.

Import validates the format, checksum, IDs, Yjs completeness, metadata, hierarchy
and required page/recovery-document entries before writing. The shared backup
format parser is separated from the browser's editor conversion adapter.
Unknown native nodes remain byte-for-byte intact; no rich-text codec runs.
Legacy-only documents are exposed with `contentState: 'legacy-only'` and retained
`legacyRecords`; native document replacement is rejected until an explicit
lossless conversion succeeds. Orphan recovery documents are accessible by ID
and through `list({includeRecovery: true})`. Embedded image data remains inside
native content/metadata; remote URLs remain references and are never fetched.
These embedded assets are not extracted into the native attachment table.

Stable IDs are preserved because import targets an isolated empty Vault. Links
need no remapping. Tombstones and metadata are preserved. The exact original
backup text is committed in the same transaction, retaining original workspace
bytes, presentation settings, legacy duplicates and previous recovery archives.
The shared browser parser can expose repaired hierarchy metadata for historical
cycles/orphans; the untouched original workspace remains in that archive.

All imported notes, change records and the archive become visible in one COMMIT.
Failure or process exit before it leaves no partial import. A valid empty schema
may remain and can be reopened and retried with `vault.importBackup(text)`.
If creation itself was interrupted and opening rejects the schema, retain that
directory for diagnosis and import into another new directory. No automatic
cleanup or deletion occurs. Unsupported versions, damaged input and old array
backups are rejected by the native importer.

Repeated API imports of the same validated payload checksum are **no-ops**, even
after local edits; they do not reset notes or advance versions. A different
backup is rejected once the Vault has notes or an import archive. The CLI always
requires a new directory, so rerunning it against an existing path fails safely.
Importing into another new directory intentionally creates an independent copy
with the same IDs. This differs from browser restore's fresh-ID additive copies.

Rollback: close all native handles and retain/copy the complete Vault directory
and original backup. Do not copy only the SQLite main file while connections are
open; WAL may hold committed data. Browser data was never modified by native
import, so continue using that original profile. Do not downgrade the browser
against the same profile: older code cannot safely interpret the new Dexie
version, overlays and tombstones. Test older builds in a separate profile.

## Native snapshots and isolated restoration

Native backups use a directory containing `manifest.json` and `snapshot.sqlite`.
Manifest format `ephemeris-native-snapshot`, version 1, supports native schemas 1–4.
This is **not** a browser v2 backup and cannot be imported into the browser.
Keep both files together. No tar/zip extraction or manifest-controlled paths run.

```text
node native/cli.js export C:/LocalVaults/work C:/PrivateBackups/snapshot-001
node native/cli.js verify C:/PrivateBackups/snapshot-001
node native/cli.js restore C:/PrivateBackups/snapshot-001 C:/LocalVaults/recovered-001
node native/cli.js inspect C:/LocalVaults/recovered-001
```

Use absolute paths on each platform; parent directories must exist. Export and
restore refuse existing destinations. Export uses Node's supported
[`sqlite.backup`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)
API, which includes committed WAL data and produces a consistent SQLite image.
Concurrent writes may be included or cause backup restarts; the result represents
one consistent committed state, not a promised timestamp at the initial call.
Do not continuously mutate the source if a backup must finish promptly.

The snapshot is sealed in DELETE journal mode with no required sidecars.
Verification checks its SHA-256, SQLite integrity and foreign keys, supported
schema, Yjs completeness/hashes, attachment checksums, latest journal versions,
retained legacy JSON and recovery archive checksums. A separate canonical digest
covers notes, attachments, changes and archives. IDs, versions, original native
bytes, tombstones and all archives survive restoration. Search data is disposable.
Portable snapshots with WAL/SHM/journal sidecars are rejected.

The manifest is published last. Before that, an interrupted export is incomplete
and verification rejects it. Restoration uses SQLite backup into a new directory
marked `.restoring`; every NativeVault open refuses that directory until full
validation succeeds and the marker is removed. A process interruption leaves
diagnostic files, not readable partial notes. Do not remove the marker manually:
retain the failed directory and restore the original backup into another new one.
Abort signals prevent publication; they do not immediately interrupt an in-flight
SQLite copy. Existing sources/destinations are never deleted or overwritten.

Rollback after a bad application change: stop the companion, close all handles,
retain the original Vault and snapshots, verify a backup, and restore into a new
directory. Validate that copy before selecting it. For browser work, keep using
the original browser profile; native restore never modifies its IndexedDB.

## Search and explicit content coverage

FTS5 with the [trigram tokeniser](https://sqlite.org/fts5.html#the_trigram_tokenizer)
is tested in the supported Node runtime. The additive index updates inside the
same transaction as the note/version/journal. An index write failure rolls back
the entire operation. Original Yjs and legacy records never depend on the index.

Text and metadata values are NFC-normalised and lowercased for literal substring
matching. Queries of at least three Unicode code points use a quoted FTS phrase;
one/two-code-point queries use `instr` over the projection because trigram MATCH
cannot find them. This supports Korean syllable substrings, English and mixed
text without claiming Korean morphological stemming. Query syntax is not exposed:
quotes and FTS operators are searched literally. Results sort by stable ID, with
bounded limit/offset pagination. Pages are not a multi-request snapshot if other
writers change notes while browsing.

Supported extraction includes the native `body` Y.Text and standard paragraph,
heading, list, blockquote, code-block, break and mention nodes in the editor's
`default` XML fragment. Unknown nodes/shared roots, embedded objects, excessive
nesting and a 1 Mi-character projection limit produce explicit `partial` or
`unsupported` coverage/reasons. Metadata remains searchable even when body text
is unsupported. Maths and custom widgets are retained, but no complete text
coverage is claimed. Deleted and recovery-only notes are excluded from search.

```text
node native/cli.js rebuild-search C:/LocalVaults/work
```

Rebuilding and `verifySearch()` check content coverage as well as FTS integrity.
Older binaries can leave the index stale; search detects missing/version-mismatched
rows and requires rebuilding. Do not edit the same Vault concurrently using old
and new binaries. The plain-text browser preview always displays coverage.

`convertLegacy(id, expected)` handles only exact doc/paragraph/text JSON with no
marks, attributes or unknown fields. It checks round-trip structure, retains the
original raw JSON and original Yjs update inside the native document, and leaves
all legacy rows and archives intact. Unsupported/ambiguous inputs fail atomically.
Conversion is explicit via the local API; neither import nor the companion runs
it automatically. The browser viewer offers original Yjs and recovery-data
downloads for unsupported documents. These downloads are recovery artefacts,
not a claimed browser-import format.

## Opt-in read-only companion

Desktop IPC would require a desktop shell, which the existing browser application
does not have. This milestone uses explicit IPv4 loopback HTTP and a dedicated
storage Worker. No listener starts with the browser, Vault import or library load.

```text
npm run preview -- --host 127.0.0.1 --port 4179 --strictPort
node native/serve.js C:/LocalVaults/work http://127.0.0.1:4179 C:/PrivateSessions/ephemeris-session.json
```

Create the private session-file parent directory first, outside this repository.
The CLI refuses an existing session file or a path within the repository. It
generates a new 256-bit bearer token, writes it with mode 0600 where supported,
and logs only the endpoint. On Windows, use a parent directory with a private
ACL. Keep the file private; do not put it in Git, shared folders or screenshots.

Open the exact configured application origin, choose **Native workspace**, load
the private session JSON and click **Connect read only**. It lists notes, searches,
previews supported text, exposes metadata/recovery downloads, downloads immutable
attachments and shows the latest 50 change records. The existing browser editor
and data remain separate. Closing/disconnecting forgets the token in the browser;
it does not revoke the still-running server session. Stop the CLI with Ctrl+C to
end the session, and use a new session-file path on restart. Tokens expire after
eight hours and rotate on every start. No reconnect/migration is automatic.

The listener binds only `127.0.0.1` at an OS-selected port. Every data request must
have the exact Host (including port), configured Origin and bearer token. Missing,
null and foreign origins fail; public application origins cannot be configured.
CORS is narrowly allowed only after Host/Origin checks and is not authentication.
The default session dispatches only GET operations. Writes, unknown/duplicate query parameters,
filesystem paths and SQL are rejected. A valid preflight can omit authentication,
but never returns Vault data. Response caching is disabled; cookies are omitted.

The default Worker owns one `NativeVault.open(..., {readOnly: true})` handle, validates it
on startup, and uses only its API. It performs SQLite, extraction and JSON encoding
away from the HTTP event loop. A worker timeout/failure makes further data calls
fail closed until restart. Attachments download as octet streams; native HTML,
metadata URLs and embedded content are never rendered as active markup or fetched.
The token is held only in browser memory, never storage, URLs or compiled assets.
Same-origin XSS, a compromised local account and stolen session files remain
outside this boundary; this is not E2EE or a multi-user permissions system.

## Verification and limits

Reproduce with Node 24.15+:

```text
npm ci
npm run lint
npm test
npm run test:native
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
git diff --check
```

GitHub Actions [run 42270936866](https://github.com/liminal-cipher/ephemeris/actions/runs/42270936866)
passed at `8b00661` on macOS, Windows and Ubuntu with Node 24. Each runner passed
69 unit, 132 native and 49 browser tests, including Chromium, Firefox and WebKit.
The earlier run `42231015207` at `03c8e5b` had failed 19 native tests on macOS;
the trusted fixture correction has now passed on an actual macOS runner.
Native tests use temporary directories and synthetic data, including a
real BrowserVault export, independent writer processes, forced journal errors,
an interrupted real importer, corruption and symlink rejection. Local results
are recorded in the 7 November UI audit and expansion sections of `ephemeris-2-handoff.md`.
Automated local and runner results do not establish human acceptance.

Known limits: no E2EE, multi-user identity/roles, deployed production service,
sync history compaction, native-to-browser backup conversion or complete
revision-history/recovery UI. Session tokens authenticate local scoped access; they
are not user accounts or encryption. Hashes detect accidental damage, not
malicious rewriting. Schema and BLOB checks are not a complete hostile-database
sandbox. Vault/backup/session directories must be trusted and private;
symlink/hardlink checks do not defeat a privileged local attacker racing file
access. Windows permissions inherit the parent ACL. Never use network filesystems
or concurrently synchronised folders. The current audit reports no advisories;
this does not eliminate same-origin script execution or compromised-account risks.

Physical power loss, hardware failure, real volume exhaustion, shipping Safari,
physical OS IME behaviour and human acceptance remain unverified.
Windows synthetic measurements cover 3,000 notes, a 256-level hierarchy and an
8 MiB attachment with backup/restore/subsequent editing. Files are synchronised before snapshot
publication; POSIX directory entries are also synchronised. Node's Windows API
does not provide the corresponding directory fsync guarantee. Do not equate
process-interruption tests with proof of power-loss durability.

50 MiB per native document/attachment and 50 MiB per browser backup remain the
existing limits. Native snapshots stream file hashing and have no archive-size
limit. The worker bounds request concurrency to four, uses a ten-second request
timeout and rejects JSON responses over 16 MiB. These controls do not establish a
strict memory budget: large metadata/documents are decoded before response-size
checking. Use the local backup API/CLI for large recovery operations. Short-query
searches scan the projection; measured costs and limits are in `sync-benchmarks.md`.

## Remaining daily-driver work

1. Test shipping Safari, real Windows/macOS IMEs, power/volume failures and human
   acceptance separately from the passing macOS/Windows/Ubuntu CI matrix.
2. Complete Markdown/YAML/Obsidian/Joplin import/export with source retention and
   corpus round trips. Rich structures unsupported by this editor remain blocked.
3. Add full sync/history/backup wizards, native backlink navigation and reference
   editing, tabs/split panes, a source-linked agenda and session renewal UX.
4. Validate signed desktop packaging, long offline periods and larger retained
   histories. Do not infer safe compaction from provider receipts.
## Schema 4 and the HTTP provider

The optional `enablePayloads()` upgrade follows `enableSync()` and
`enableRecovery()`. It adds content-addressed attachment chunks and resource
limits while preserving existing operations and backup format 1. All peers
must understand schema 4/protocol 3 before using it.

`syncRetention(noteId)` explains retained history and current quotas.
`configureSyncResources(limits)` can set lower logical quotas.
`restartSyncTarget(target, expectedEpoch, newEpoch)` explicitly requeues
surviving operations for one provider; it never deletes local notes or history.
The authenticated server/client CLIs, configuration, recovery procedure and
current limitations are described in [the provider guide](sync-provider.md).

## Explicit native editing and recovery

Use the same local preview origin as above. Start a **separate** editing session:

```text
node native/serve.js C:/LocalVaults/work http://127.0.0.1:4179 C:/PrivateSessions/edit-session.json --edit
```

On macOS use real absolute paths beneath your home directory. Session parents
must exist and the session file must be new. Production Vault paths still reject
symlink traversal; the macOS test fixture correction does not relax that rule.

Load the new file in Native workspace and choose **Connect for editing**. Its
version 2 session lasts at most 15 minutes and grants only `notes:create`,
`notes:update`, `notes:delete`, `notes:restore` and `attachments:create` on the
one selected Vault. Programmatic callers can grant a subset. Existing version 1
tokens remain read-only. Starting a new session rotates credentials; reconnect
with its new file. There is currently no in-app token renewal.

POST requests require the exact Origin/Host, bearer authentication and
`application/json`, and are capped at 8 MiB. Authentication expiry is rechecked
after reading the body. Existing-note writes require both version and content
hash. The Worker independently checks operation permission. No API accepts a
filesystem path, SQL, sync configuration or arbitrary method name.

Create or open a note, select **Edit native note**, change its title/body and wait
for **Saved to Native Vault**. Ctrl/⌘+S saves and Ctrl/⌘+Z undoes within the active
editor. Ctrl/⌘+K focuses native search. Move uses another note's stable ID; an empty
parent moves to the root. Trash preserves content and attachments; restore
explicitly returns the note to the root. Browser uploads are capped at 4 MiB;
downloads use a neutral `.bin` name and never execute attachment content.

The editor binds directly to a Y.Doc loaded from SQLite, retaining native roots,
IDs, marks and supported maths. It refuses unknown structures/attributes and
legacy-only/plain `body` documents rather than normalising them through Tiptap.
Their original Yjs and recovery JSON remain downloadable. The browser editor and
its original IndexedDB data are independent and remain available even if the
native Companion stops. Native workspace can also open when BrowserVault fails.

Pending writes are stored in a bounded IndexedDB recovery journal without any
credentials. Writes use strict durability and wait for transaction completion
before claiming retention or sending to the Companion. The UI distinguishes
securing a draft from a retained draft. A localStorage implementation failed an
actual Chromium process-kill test and was replaced; the strict journal passed
kill/relaunch/recover/save using the same isolated synthetic browser profile.
Each editor/tab has its own draft key; the namespace identifies the
physical Vault file, not a portable sync identity. A restored/replaced database
does not automatically receive another file's drafts. Native document admission
is limited to 1 MiB of Base64, with a 2 MiB JSON draft limit including an in-flight
snapshot. These conservative UI limits are below the native storage limits.

If the Companion stops, keep the browser data and reconnect with a new session
for the same Vault. **Retained drafts** can reopen or download pending content.
A lost acknowledgement is accepted only when the observed next version and exact
submitted document/metadata match; otherwise the draft enters conflict. Compare
the saved version or save the draft's text/properties as a separate note. Original
notes and retained drafts remain intact. Attachments stay on the original note;
this action is not a complete attachment-bearing Vault clone. Storage failures
stop editing and require a draft download before leaving. Browser eviction,
physical power loss and every possible crash timing are not guaranteed by these
tests; keep verified native snapshots.

Quick Capture creates an Inbox-tagged note. Daily Note reopens the same local
calendar day's stable ID; a deleted daily note requires explicit restoration.
The meeting template includes dated headings and next actions. Properties cover
tags, project, status, due date and favourite; unknown unchanged metadata survives.
Views filter these canonical properties and offer table, cards and Kanban layouts,
title/recent/due ordering, and saved definitions. Definitions are ordinary Vault
metadata, not copied editable notes. Boards group only the current 30-note page;
the total, paging controls and empty state are explicit. Layout/filter preferences
are local, while saved definitions travel with the native Vault.

## Read-only local MCP

```text
node native/mcp.js --vault C:/LocalVaults/review-copy --tools list_notes,search_notes,read_note,note_metadata,note_links,recent_changes,project_tasks
```

Use an absolute script path when a consuming MCP application's working directory
differs from this repository. Omitting `--tools` exposes the seven read-only
tools; provide a smaller comma-separated list to narrow access. There are no write
tools, arbitrary filesystem/SQL access, HTTP listener or implicit cloud requests.
The selected Vault opens read-only and must already have a valid searchable index.

The server implements the [MCP 2025-11-25 stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
initialise/initialised lifecycle, ping, tools/list and tools/call. JSON messages are
newline-delimited UTF-8. Input messages are capped at 64 KiB and tool-result data at
24 KiB; output never contains non-protocol stdout logs. Tool pages admit at most
50 notes; read sections at most 8,192 Unicode characters. Follow `nextOffset` and
inspect coverage. Backlinks scan a bounded page of source notes. Tasks are read-only
checkbox projections with source-note IDs and projection line numbers, not another
editable task database. Oversized metadata requires selected fields/smaller pages.

**Local execution does not mean model-provider privacy.** The server sends no
network requests, but the consuming application may forward tool responses to
an external model. Review its permissions and provider settings before granting
access to private notes. Note content is untrusted data, not tool instructions.
Real subprocess tests exercise protocol negotiation, permissions, pagination,
Korean text, links/tasks, invalid paths/SQL fields and output bounds.

## Desktop distribution decision

The currently validated development workflow remains browser plus local Node
Companion. No desktop runtime dependency, installer, signing or release was added.

| Option | Runtime and boundary | Delivery and maintenance |
| --- | --- | --- |
| Browser + Companion | Uses the tested Node 24 SQLite process and browser sandbox; scoped loopback API | Small project payload, existing browser/runtime required. Browser file inputs work; Vault selection/startup still require the local CLI. No bundled updater |
| Electron | Bundles Chromium/Node; its actual bundled Node/SQLite version needs acceptance testing. Renderer must have Node integration disabled, context isolation and a narrow IPC bridge | Native dialogs available; larger runtime bundle and regular Chromium/Electron security updates. Windows/macOS installers, signing and update infrastructure still needed |
| Tauri + Node sidecar | OS webview plus separately packaged Node 24 executable; explicit sidecar capabilities and lifecycle required | Smaller webview shell, but Node must still be shipped per OS/architecture. Rust/webview/sidecar updates and Windows/macOS packaging add maintenance; native dialogs available |

This is a risk comparison, not an installer-size measurement or proof of bundled
SQLite compatibility. Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
requires careful renderer isolation and dependency updates. Tauri documents
[per-target sidecar binaries and scoped execution](https://v2.tauri.app/develop/sidecar/).
A launcher prototype should follow actual macOS acceptance and a tested runtime
bundle. Playwright WebKit on Windows is browser-engine coverage, not shipping
Safari validation. No unsigned prototype is described as notarised or ready for
frictionless public distribution.
