# ADR 0002: Causal operations and a transactional sync outbox

Status: Phase C-1 simulated implementation. Local simulator
only; no production provider, credentials, encryption or browser write API.

## Contract and transaction boundary

`enableSync()` explicitly upgrades schema 1 to schema 2 in one transaction.
Existing note bytes, versions, change records and recovery archives stay intact.
The additive tables retain a Vault ID, client ID, immutable operations, per-target
delivery state, incoming operations, checkpoints and immutable conflict records.
Opening a Vault never starts synchronisation or activates this migration.

Protocol 1 operations contain an independent UUID, Vault/client identity, local
journal sequence, parent operation IDs for the same note, a full recovery snapshot,
changed field names and SHA-256 over canonical JSON. Note versions remain local.
Parent IDs, not wall clocks, establish causality. IDs never become file paths.
Attachments are dependencies embedded with their ID, metadata, bytes and checksum;
there are no visible dangling attachment references in an accepted operation.

Every enabled local mutation records its operation in the same SQLite transaction
as the note, attachments, search projection and existing journal. Existing notes
receive baseline operations when enabled. An operation ID is stable across retries.
All target deliveries are pending, retryable or acknowledged; retry delays double
from one second to a maximum of one minute. Acknowledgements require matching
operation ID, checksum and target epoch. Time schedules retries only.

The provider contract is asynchronous `info`, `publish` and `pull`. A publication
acknowledgement promises durable acceptance. Cursors are bounded opaque JSON,
scoped to a stable target ID and epoch. A changed epoch or invalid cursor stops
sync for explicit recovery; an empty listing never deletes local records.

Incoming pages, deduplication, materialisation, conflicts and the cursor commit
together. Out-of-order operations whose parents are absent remain in a durable
inbox; advancing that cursor acknowledges durable retention, not visibility.
The returned waiting count exposes incomplete dependencies. Invalid ready
operations roll back the page. Retrying after acceptance or before local commit
is safe. Cursor comparison prevents concurrent sessions from overwriting a newer
checkpoint; SQLite serialises mutations. No lease whose expiry loses correctness
is needed. Provider calls occur outside SQLite transactions.

Applied remote operations do not generate new outbound IDs. Their original IDs
can be forwarded once to another explicitly configured target. Observations from
the source target are acknowledged, so repeated sync has no echo mutations.

## Reconciliation and retained versions

Each metadata field is a causal register. Independent fields merge. Concurrent
different values retain immutable unresolved conflict records identifying both
complete operations. The smallest operation ID selects a deterministic display
value only; this is not resolution or wall-clock last-write-wins. Renames and
moves obey the same rule. Cross-note missing-parent operations wait; invalid
hierarchies fail the page rather than bypassing NativeVault validation.

Compatible native Yjs snapshots merge using Yjs. Legacy-only competing documents
remain unresolved. Merging requires common causal ancestry and preservation of
the ancestor's Yjs client clocks. Independent same-ID documents and replacement
histories remain unresolved. Recovery rows and legacy records are retained. Concurrent
attachment ID collisions preserve both byte sequences in retained operations;
only a deterministic display variant is materialised. Deletion wins concurrent
edit/restore races. Only a restoration causally after all known deletion writers
revives a note. Delete-versus-edit has explicit retained conflicts.

`syncConflicts(noteId)` and `retainedSyncOperation(operationId)` expose immutable
conflict history and exact snapshots. No automatic conflict-resolution UI exists.
All operations are retained; history compaction and attachment deduplication are
deferred. This favours recoverability over storage efficiency.

## Compatibility, recovery and current limits

Native backup format 1 now accepts SQLite schema 1 or 2. Schema 2 snapshots retain
the full outbox, inbox, client identity, checkpoints and conflict history. The
old Phase B binary rejects schema 2 safely; rollback uses a pre-activation schema
1 backup in a new directory. Do not lower `user_version` or remove sync tables.

Restore preserves identity and delivery state for disaster recovery. Before
editing a restored copy alongside the original, call `forkSyncClient()` on the
copy: it assigns a new client ID while retaining the Vault ID and old operations.
This is an explicit fork, not a new identity on every open. Otherwise the provider
rejects duplicate client/sequence identities with different content. Do not run
two editable raw filesystem clones under the same client identity.

Invalid causal graphs, checksums and ready field baselines are rejected. Missing
dependencies remain inspectable through retained operations and the waiting count.
Cross-note cyclic moves or references to deleted parents can stop application;
they are not automatically repaired. Source operations remain durable, but manual
recovery of these structural cases is still required. There is no resolution API
for replacing an invalid historical operation, so use a new isolated target/Vault
after inspecting and recovering the retained snapshots. No remote cursor reset
is automatic. A replaced remote needs a new explicit target ID to resend history.

Full browser import archives remain local and in native backups; note-level
legacy records and native bytes are transferred. A sync provider is not a complete
Vault backup. Attachments are embedded per operation, so large histories are
expensive. The JSON operation limit is 50 MiB including base64; enabling sync or
editing a note that exceeds it fails atomically. No large-Vault throughput claim
is made. Reconciliation scans retained history and runs synchronously; callers
must host the engine in a Worker for interactive applications. No automatic
background scheduler, compaction, garbage collection or production transport is
included. Checksums detect corruption, not malicious authorised peers; future
providers need authenticated transport, access policy and resource budgets.

The simulator's exported state is test-harness state, not a production durable
server. Tests persist it before terminating clients to model remote acceptance.
Timeouts abandon waiting; an asynchronous provider may still accept later, so
idempotency remains essential. Retry scheduling is durable but caller-driven.

## Reference study and independent design

Inspected Joplin's current `dev` sources and tests on 29 October 2026:

- [Synchronizer](https://github.com/laurent22/joplin/blob/dev/packages/lib/Synchronizer.ts): separate uploads, delta retrieval and saved cursors; protect against missing remote state.
- [BaseItem](https://github.com/laurent22/joplin/blob/dev/packages/lib/models/BaseItem.ts): per-target item state and retained merge baselines.
- [ItemUploader](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/ItemUploader.ts), [tests](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/ItemUploader.test.ts): acceptance and upload state belong together.
- [Deletion](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/utils/syncDeleteStep.ts) and [conflicts](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/utils/handleConflictAction.ts): preserve evidence before destructive reconciliation.
- [Basic tests](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/Synchronizer.basics.test.ts) and [conflict tests](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/Synchronizer.conflicts.test.ts): independent client state and preserved conflicting content.
- [LockHandler](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/LockHandler.ts) has expiry and explicit lock types; its current [test file](https://github.com/laurent22/joplin/blob/dev/packages/lib/services/synchronizer/synchronizer_LockHandler.test.ts) disables the old tests. This is not evidence of current lock test coverage.

Only principles informed this design. No Joplin implementation was copied. This
MIT implementation uses a causal DAG and immutable operations instead of copying
Joplin's item/timestamp protocol or its transport-specific locking.
