# ADR 0003: Explicit sync recovery and resource budgets

Status: implemented for the local simulator, 1 November 2026. This extends
[ADR 0002](0002-native-sync.md); it does not authorise a network provider.

## Explicit schema 3 upgrade

`enableSync()` retains its schema 1 to 2 contract. `enableRecovery()` explicitly
upgrades an already enabled schema 2 Vault to schema 3 in one transaction. New
tables are `sync_projection`, `sync_structures`, `sync_resolutions` and
`sync_dependencies`. Existing identities, payloads, acknowledgements, cursors,
legacy rows and archives are preserved. Existing operation payloads are never
rewritten. Dependency and note/delivery indexes are added without deleting data.
Failure, including a conflicting table or an exceeded per-note history budget,
rolls back the entire upgrade. Opening a Vault performs no migration or sync.

Native snapshot format 1 now supports SQLite schemas 1, 2 and 3. Verification
checks requested projections against retained operations, safe materialisation,
dependency indexes, structural evidence and resolution references. Missing tables
in a declared schema are rejected on open. Restore preserves Vault/client IDs;
`forkSyncClient()` remains mandatory before editing a clone alongside its source.
Older binaries reject schema 3 and protocol 2 resolution operations. All peers
participating in resolution exchange must explicitly upgrade first.

## Requested hierarchy versus safe materialisation

The operation DAG remains immutable recovery history. `sync_projection` caches
its requested note snapshots, heads and hierarchy writers; it is not an editable
second source of truth. The materialised notes/search index represent a safe tree.

On schema 3, ready operations are accepted even if their requested hierarchy is
temporarily invalid. Before publication, a whole-tree check detects cycles,
missing parents and deleted/recovery-only parents. Each edge participating in a
cycle, or directly pointing at an unavailable parent, is temporarily displayed
at the root. All original requested parents remain in snapshots and the requested
projection. No note is erased, hidden from search, moved to another chosen parent
or resurrected. Descendants of a detached live note stay attached to that note.

This temporary representation is not a resolution. `syncRecovery()` identifies
affected notes, source operations, reason, requested parent and temporary parent.
`requestedSyncNote(id)` returns the original requested snapshot. Ordinary title
edits do not accidentally convert a temporary root into a requested move.
When a missing parent arrives or a parent is explicitly restored, the original
edge can become valid again; the structural observation remains retained history.

Missing causal ancestors are different: their operations remain staged and are
not reconciled until dependencies arrive. Recovery inspection identifies them as
`missing-causal-dependency`; its dependency detail list is limited to 100 entries
per inspection. `syncStatus()` retains the complete waiting count. Invalid causal
cycles, cross-note causal-parent edges or corrupt payloads still reject the page.

All related hierarchy changes, journals, FTS projections, evidence and the remote
cursor share one SQLite transaction. The final tree is validated before applying
individual rows, avoiding checks against a partially updated intermediate tree.
Process termination before COMMIT exposes neither half of a structural repair.

## Explicit resolution operations

`resolveSyncConflict(noteId, conflictId, decision, expected)` requires the current
local note version and exact causal heads. A decision supplies exactly one of
`operationId` (a competing version of the same note) or `value` (validated field
replacement). Supported fields are metadata, parent ID, deletion, native document
bytes encoded as canonical Base64, and a complete checksummed attachment record.
The API never invents a rich-text conversion or synthesises a deletion/restore
intent. Choosing `null` for deletion explicitly restores; a new concurrent delete
still wins. Choosing an attachment keeps all alternative bytes in retained
snapshots; there is no attachment garbage collection.

The new protocol 2 operation carries the usual snapshot/parents plus `resolution`:
conflict IDs, complete immutable conflict evidence, referenced original operation
IDs and the explicitly written field. It writes that field even when the chosen
value equals the current display value, so both same and competing resolutions
have causal meaning. Cross-note structural evidence references are dependencies,
not same-note DAG parents. Evidence travels with the resolution, so a fresh
device can inspect a conflict it never observed live.

Original conflict payloads keep their original unresolved status. The inspection
API derives current `status` and `resolutions` from new immutable records. A
resolved old conflict may coexist with a new unresolved conflict caused by racing
resolutions or edits. A historical structural observation can remain explicitly
unresolved after its temporary condition disappears; `syncRecovery()` reports
only current structure problems. Resolution is never silently inferred from an
ordinary edit. There is no full resolution UI or browser write route.

## Resource boundaries

- Each operation remains limited to 50 MiB of JSON including Base64.
- Engine pages/pending batches have a configurable 1 KiB–64 MiB operation-payload
  budget plus a maximum of 100 operations; cursor JSON is limited to 4 KiB.
- Each receive transaction applies at most 200 ready operations. Remaining work
  stays durable and resumes on a later page/call. Indexed dependencies avoid
  repeatedly decoding all blocked payloads.
- Schema 3 limits each note's retained operation payloads to 64 MiB and 1,024
  operations. The next local edit or incoming insert fails atomically, without
  acknowledging it or advancing its cursor. Migration beyond these limits also
  fails atomically; the original schema 2 Vault remains usable.
- Linear histories avoid quadratic ancestor-set construction during normal
  reconciliation. Nonlinear conflict reconciliation and full backup verification
  still require substantial work. Whole-tree projection scans note summaries.
- Engine checkpoints no longer enumerate every delivery record. Existing
  diagnostic APIs and full integrity verification are not streaming APIs.

These are input/work budgets, not a constant-memory guarantee. The measured
32 MiB attachment case peaked near 1 GiB RSS because snapshots and Base64 are
copied several times. A second full snapshot can exceed the per-note budget and
block further edits. The current API returns an explicit error; there is no safe
compaction escape hatch yet. Keep a native backup and retained versions. Do not
delete history or raise limits blindly. This is a prototype resource safety
boundary, not a production capacity target. See [measurements](../sync-benchmarks.md).

## Future production provider contract

The asynchronous API remains `info()`, `publish(operation, epoch)` and
`pull(cursor, { limit, maxBytes, epoch })`. A future adapter must:

1. Return a stable provider identity, explicit tenant/Vault namespace and epoch.
   Bind authenticated credentials to that namespace server-side. The engine
   requires an explicit matching namespace and uses independent checkpoint keys
   for non-default namespaces (`providerTargetId`). Local checks are not access
   control; unauthorised reads/writes must be rejected by the server.
2. Return the exact operation ID, checksum and epoch only after durable storage
   of the entire operation and attachment dependencies. Reuse with identical
   content is idempotent; reuse with different content is rejected. Do not use
   a successful HTTP upload alone as evidence of durable acceptance.
3. Make acknowledged history available to a newly bootstrapped device starting
   at a null cursor. Duplicate/out-of-order delivery is allowed; missing retained
   dependencies must eventually be delivered or reported as a permanent problem.
4. Treat cursors as opaque, namespace/epoch-scoped values. Expired cursors and
   replaced epochs require explicit recovery, never a silent reset or inference
   that absent remote notes were deleted. Resend retained history to a separately
   chosen target namespace after investigating remote loss.
5. Enforce byte/count limits before buffering network responses and attachment
   bodies. The local engine checks returned objects but cannot undo memory used
   by an adapter while parsing. Interrupted uploads may later succeed; retries
   must reuse the original ID. Interrupted downloads must not commit cursors.
6. Represent `UNAUTHENTICATED`, `FORBIDDEN`, `REVOKED`, `INVALID_OPERATION`,
   `OPERATION_TOO_LARGE`, `CURSOR_EXPIRED` and `EPOCH_CHANGED` as permanent errors.
   The engine stops without scheduling an exponential retry for these errors.
   Transient errors/timeouts use the existing bounded retry state. Revocation
   must be checked on every server operation, not merely at client startup.
7. Authenticate peers and enforce permissions, transport confidentiality, replay
   policy and tenant isolation independently of checksums. This protocol does not
   establish safety against malicious authorised peers or provide E2EE.

`native/test/provider-conformance.js` is reusable with an isolated adapter fixture.
The current suite checks identity, reopening a persisted simulator state,
idempotency, matching acknowledgements, cursor handling and byte bounds. Engine
tests cover represented authentication failures, namespaces, oversized responses,
remote loss and failures after acceptance. This does not certify a real server's
durability, authentication implementation or cross-device reliability.

Before a production adapter: implement streamed/chunked attachment handling,
benchmark and bound nonlinear histories and total database growth, define a safe
history-retention/compaction protocol for offline/forked clients, test real server
crash durability and authenticated isolation, and execute the OS CI matrix.
