# Native Vault milestone

Current integration work starts from fetched `main` at `e061cfd`, 29 October
2026. Native snapshots, indexed search and an opt-in read-only browser companion
are implemented. BrowserVault remains the browser editor's canonical store.
There is no production Sync Engine or MCP server. Overall Phase B is not declared
complete pending platform verification and the remaining acceptance work below.

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
and timestamp. It records changes, not full historical revisions or a durable
sync outbox. Native writes replace a complete validated Yjs snapshot; callers
must merge updates in a Y.Doc and submit its full state. Incomplete deltas are
rejected. Automatic conflict merging is deliberately deferred.

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
3. Inspect notes through the API before considering a future editor integration.
   Keep using the original browser application for editing in this milestone.

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
Manifest format `ephemeris-native-snapshot`, version 1, supports native schema 1.
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

FTS5 with the [trigram tokenizer](https://sqlite.org/fts5.html#the_trigram_tokenizer)
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
Only GET operations are dispatched; writes, unknown/duplicate query parameters,
filesystem paths and SQL are rejected. A valid preflight can omit authentication,
but never returns Vault data. Response caching is disabled; cookies are omitted.

The Worker owns one `NativeVault.open(..., {readOnly: true})` handle, validates it
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
npx playwright install chromium
npm run test:e2e
git diff --check
```

GitHub Actions is configured to run the complete native/browser pipeline on
Node 24, on both Ubuntu and Windows. This local change has not run remotely. Native tests use temporary directories and synthetic data, including a
real BrowserVault export, independent writer processes, forced journal errors,
an interrupted real importer, corruption and symlink rejection. Local results
are recorded in the Phase B section of `ephemeris-2-handoff.md`. Remote CI and
human acceptance are separate from those results.

Known limits: no E2EE, multi-user identity/roles, native browser writes,
production sync/outbox, compaction, native-to-browser backup conversion or full
revision-history recovery. Session tokens authenticate local read access; they
are not user accounts or encryption. Hashes detect accidental damage, not
malicious rewriting. Schema and BLOB checks are not a complete hostile-database
sandbox. Vault/backup/session directories must be trusted and private;
symlink/hardlink checks do not defeat a privileged local attacker racing file
access. Windows permissions inherit the parent ACL. Never use network filesystems
or concurrently synchronised folders. Existing browser dependency advisories
remain relevant, particularly same-origin script execution risks.

Physical power loss, hardware failure, actual disk-full I/O, Linux/macOS execution,
large-Vault performance and human acceptance remain unverified locally. Linux CI
is pending: no local WSL distribution or Docker runtime was available, and this
work was not authorised for publication. Files are synchronised before snapshot
publication; POSIX directory entries are also synchronised. Node's Windows API
does not provide the corresponding directory fsync guarantee. Do not equate
process-interruption tests with proof of power-loss durability.

50 MiB per native document/attachment and 50 MiB per browser backup remain the
existing limits. Native snapshots stream file hashing and have no archive-size
limit. The worker bounds request concurrency to four, uses a ten-second request
timeout and rejects JSON responses over 16 MiB. These controls do not establish a
strict memory budget: large metadata/documents are decoded before response-size
checking. Use the local backup API/CLI for large recovery operations. Short-query
searches scan the projection; large-Vault search performance is not benchmarked.

## Next steps before and during Phase C

1. Finish Phase B acceptance: execute the Ubuntu/Windows CI matrix after an
   authorised publication; test macOS, actual disk-full failures, large Vaults and
   recovery on representative data copies. Extend codecs only with round-trip
   evidence. Native-to-browser export and native editor writes remain separate
   future contracts, not capabilities of this read-only milestone.
2. Study upstream synchroniser/locking/conflict tests without copying AGPL code.
   Specify a provider-neutral record format and deletion/conflict semantics.
3. Extend transactions with a persistent outbox and immutable conflict/revision
   records; define idempotency keys, attachment dependencies and remote cursors.
4. Test two independent SQLite Vaults against a deterministic simulated provider:
   duplicate/out-of-order delivery, disconnection, retries, deletion/edit races,
   interrupted uploads and resumption. Do not treat local writer races as sync.
5. Only after those contracts pass, implement and separately authorise a real
   transport. MCP remains a later adapter over this same validated API.
