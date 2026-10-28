# Native Vault milestone

Implemented against fetched `main` at `778f47d`, 29 October 2026.
This is the native storage and isolated migration milestone of Phase B. The
browser still uses BrowserVault; there is no running companion service, browser
transport, Sync Engine or MCP server. Overall Phase B is not declared complete.

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
a future transport should put storage work on a dedicated worker and revalidate
runtime upgrades. This API stability trade-off avoids another native dependency.

Each Vault is a newly created local directory containing `vault.sqlite` and
SQLite-managed sidecars. Schema version 1 uses strict tables for notes,
attachments, changes and import archives. Yjs binary state is canonical;
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
| `close()` | Idempotently closes the connection. |

`expected` is `{version, contentHash?}`; passing the previously read note works.
`ConflictError` means reread and explicitly reconcile before retrying. Other
SQLite/validation errors propagate; failed operations must not be acknowledged
as saved. Parent deletion does not cascade in this API. Children keep their
original parent ID and remain listed; future tree adapters must render children
of hidden parents at a visible root. This intentionally avoids implicit subtree
deletion with unverified descendant versions.

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
lossless conversion path exists. Orphan recovery documents are accessible by ID
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

GitHub Actions runs native tests alongside the existing browser pipeline on
Node 24. Native tests use temporary directories and synthetic data, including a
real BrowserVault export, independent writer processes, forced journal errors,
an interrupted real importer, corruption and symlink rejection. Local results
are recorded in the Phase B section of `ephemeris-2-handoff.md`. Remote CI and
human acceptance are separate from those results.

Known limits: no encryption/authentication, no native UI or browser transport,
no full-text index, no lossless legacy converter, no sync/outbox, no compaction,
no native-to-browser exporter and no revision-history recovery. Hashes detect
accidental damage, not malicious rewriting. Schema and BLOB checks are not a
complete hostile-database sandbox. Vault directories must be trusted and private;
symlink/hardlink checks do not prevent a privileged local attacker swapping paths
after validation. Windows permissions inherit the parent ACL. Do not place Vaults
on network filesystems or in concurrently synchronised folders. File ACLs,
physical power loss, hardware failure, disk-full I/O, Linux/macOS execution and
large-Vault performance remain unverified locally. Lists return full documents;
50 MiB per document/attachment and 50 MiB per imported backup are safety limits,
not a tested memory budget. Existing browser dependency advisories remain.

## Next steps before and during Phase C

1. Finish Phase B integration: lossless legacy conversion, native export/recovery,
   indexed search and a scoped companion adapter with explicit access policy.
   Keep storage validation and transactions behind the existing API. Test Linux,
   macOS, actual disk-full errors and browser/native contract behaviour.
2. Study upstream synchroniser/locking/conflict tests without copying AGPL code.
   Specify a provider-neutral record format and deletion/conflict semantics.
3. Extend transactions with a persistent outbox and immutable conflict/revision
   records; define idempotency keys, attachment dependencies and remote cursors.
4. Test two independent SQLite Vaults against a deterministic simulated provider:
   duplicate/out-of-order delivery, disconnection, retries, deletion/edit races,
   interrupted uploads and resumption. Do not treat local writer races as sync.
5. Only after those contracts pass, implement and separately authorise a real
   transport. MCP remains a later adapter over this same validated API.
