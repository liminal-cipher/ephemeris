# Chunked sync and the durable HTTP provider

This native Node service stores operations and attachment chunks in a separate
SQLite database. It is independent of the browser application and its read-only
Companion. Node 24.15 or newer is required. No new dependencies are needed.

## Upgrade and local use

Export and verify a native backup before upgrading an existing Vault. Upgrade
every participating peer before sending protocol 3 operations:

```text
node native/cli.js enable-sync <absolute-vault-directory>
node native/cli.js enable-recovery <absolute-vault-directory>
node native/cli.js enable-payloads <absolute-vault-directory>
```

These steps explicitly select schemas 2, 3 and 4. Opening a Vault or starting
sync never upgrades it automatically. Existing operation IDs, checksums, inline
attachments and conflict evidence are retained. Old binaries cannot open schema
4; rollback requires the pre-upgrade backup in a separate directory. Native
snapshot format 1 now accepts schema 4 and includes its chunks and limits.

The server and client CLIs read private JSON configuration files outside this
repository. Neither CLI prints bearer tokens. Generate a high-entropy token
(for example, `randomBytes(32).toString('base64url')` from `node:crypto`) and
place its SHA-256 hex digest in the server's `principals`. Place the original
token only in the corresponding client configuration. These are operator
provisioning steps; the implementation does not provision real credentials.

Server configuration fields:

| Field | Meaning |
| --- | --- |
| `directory` | Absolute trusted local directory for `provider.sqlite` |
| `principals` | Array of `{ tokenHash, namespace, revoked? }`; each token has one namespace |
| `host`, `port` | Defaults: `127.0.0.1`, automatically allocated port |
| `tls` | For the CLI, `{ keyFile, certFile }` pointing to operator-managed TLS files |
| `authority` | Optional exact HTTP Host value, including the port when needed |
| `limits` | Optional lower limits from `DEFAULT_PROVIDER_LIMITS` |
| `cursorTtlMs` | Default seven days; at most thirty days |

Client configuration fields are `url`, `token`, `namespace` and optionally
`timeoutMs` or a lower `maxOperationBytes`. Token strings use the Base64url
alphabet and contain 32–256 characters. A namespace identifies one shared
workspace, not an individual local Vault. All holders of a namespace's token
can read and write that workspace.

```text
node native/sync-server.js <absolute-private-server-config.json>
node native/sync-client.js <absolute-vault-directory> <absolute-private-client-config.json>
node native/cli.js retention <absolute-vault-directory> <note-id>
```

The server prints its URL. A client pass reports `uploaded`, `applied`,
`waiting` and `hasMore`, plus `retryAt` when retry backoff defers pending work.
Exit 0 means the pass completed without waiting
dependencies; exit 2 means more work or missing causal history remains.
The client runs at most 1,000 bounded cycles and supports cancellation.
There is no background scheduler or browser write endpoint.

## Data flow and guarantees

1. A schema 4 attachment is divided into 256 KiB chunks. Operations contain
   its whole-content hash, size and ordered chunk hashes, rather than Base64
   file contents. The original attachment remains materialised in the Vault.
2. The client checks and uploads missing chunks before publishing an operation.
   Each chunk is bounded and hash-checked; unchanged chunks are reused.
3. The server authenticates before reading a body, binds it to the principal's
   namespace and rechecks revocation after reading. It verifies referenced
   content before accepting a new operation.
4. An acknowledgement is returned only after SQLite COMMIT. Reusing an operation
   ID or client sequence with different content is rejected. Retrying accepted
   operations returns the original acknowledgement without another row.
5. A receiving client fetches and verifies missing chunks before applying the
   page. Notes, projections, conflict evidence and the cursor share the Vault
   transaction. Verified chunks staged before a failed page remain bounded,
   reusable data; the note and cursor do not advance.

The server uses WAL with `synchronous=FULL`. This follows SQLite's documented
[WAL durability contract](https://www.sqlite.org/pragma.html#pragma_synchronous).
The executed tests cover process termination and `SQLITE_FULL`, not physical
power loss or a storage device that violates flush guarantees.

HTTP is permitted only at explicit loopback IP addresses. Non-loopback server
binding requires TLS, and the client requires HTTPS for non-loopback URLs.
Certificate validation remains enabled; redirects are refused. Host and Origin
checks exclude browser-origin requests. Request timeouts and header limits use
the standard [Node HTTP controls](https://nodejs.org/docs/latest-v24.x/api/http.html#serverrequesttimeout).
Public deployment, certificates, external-device networking and service
monitoring have not been exercised by the local test suite.

## Limits and retention

| Boundary | Default ceiling |
| --- | ---: |
| Chunk request or response | 256 KiB |
| HTTP operation JSON | 2 MiB |
| HTTP pull operation JSON total | 4 MiB, plus a bounded cursor/envelope |
| HTTP concurrent active requests / sockets | 16 / 64 |
| Vault or provider retained operation JSON | 256 MiB / 100,000 operations |
| Vault or provider unique chunks | 512 MiB / 262,144 chunks |
| Vault materialised attachment bytes | 512 MiB, including duplicate attachments |
| Provider main SQLite database pages | 2 GiB; WAL and filesystem overhead are additional |
| Vault per-note history | 64 MiB / 1,024 operations |
| Nonlinear reconciliation | 250,000 pair checks / 10,000 conflict records |

Provider content quotas apply per namespace; its database page ceiling applies
to the entire server. Vault limits apply to the entire Vault and can be lowered
using `configureSyncResources()` with the complete limits object. Lowering a
limit below retained usage fails. A local edit or incoming page exceeding its
limit rolls back. Provider quotas reject acceptance and preserve pending local
deliveries. A SQLite full error is retryable after storage capacity is restored.

These are logical bounds, not hard process RSS or whole-disk quotas. Yjs
documents, metadata and legacy records still use operation snapshots; the HTTP
2 MiB envelope can reject a large document even when its attachments are chunked.
Existing inline histories are not rewritten. A reached per-note history limit
still requires a separately designed retention/migration strategy.

`syncRetention(noteId)` reports usage, per-note budgets, unresolved conflicts,
waiting operations and acknowledgements from every configured provider.
`safeToDeleteOperations` is always zero. A server acknowledgement does not prove
that an offline client, restored backup or fork has consumed an operation.
Unresolved evidence, causal ancestors and pending provider deliveries are
retained. No automatic compaction, expiry-based deletion, remote reset or
history-budget bypass is provided. See [the design decisions](../DECISIONS.md).

## Recovery and credential revocation

Cursor tokens carry a signature, namespace, epoch, offset and expiry. A stale,
forged or cross-namespace cursor fails closed. An expired cursor in an unchanged
epoch can be explicitly restarted, preserving all local operations:

```text
node native/sync-client.js <vault> <client-config> --restart-cursor
```

When restoring a server backup, stop all server instances, restore a consistent
SQLite image, and change its epoch before allowing clients to reconnect. The
embedding API exposes `server.rotateEpoch(expectedEpoch)`; it retains rows and
invalidates previous cursors. Do not copy a live SQLite main file without its
transactional backup procedure. A client must explicitly accept the observed
new epoch:

```text
node native/sync-client.js <vault> <client-config> --accept-epoch <exact-new-epoch>
```

This requeues every local operation, clears only that target's checkpoint and
retains note data, conflicting versions and other providers' delivery state.
Replaying all surviving clients can repopulate data missing from a restored
server. It cannot recover data absent from every surviving client and backup.

The embedding API also exposes `server.revoke(tokenHash)`. Revocation hashes
persist across restart. A server configuration can mark a principal `revoked`
or remove it before restarting. Configuration changes are not hot-reloaded.
There is no public administrative endpoint. Already committed operations are
not undone by revocation. Protect the server directory and private configurations
with operating-system permissions; transport authentication is not E2EE.

## Verification and human acceptance

The reusable provider conformance suite runs against both the simulator and a
real local TCP server. Additional tests cover exact chunk transfer, tenant
isolation, revocation across restart, response limits, redirects, cursor expiry,
epoch recovery, abrupt server termination, interrupted upload, quota rollback,
SQLite's actual `SQLITE_FULL` error and the server/client CLIs.

```text
npm run test:native
node native/benchmark-resources.js payload-http
```

For human acceptance, use disposable synthetic Vaults A and B. Export and verify
backups, enable schemas 2–4, create a note with an attachment in A, and run each
client against the same namespace. Confirm the exact attachment in B. Rename
the note in B, sync both, and inspect A. Stop and restart the server, repeat the
pass, then verify that revoked credentials are rejected and existing local notes
remain readable. Restore a Vault backup into a new directory and use
`forkSyncClient()` before editing beside the original. Compare unresolved
conflict evidence before and after recovery.

Physical power-loss, real volume exhaustion, non-loopback TLS operation,
independent devices and human acceptance remain NOT RUN. The CI matrix is
prepared for Windows, Ubuntu and macOS; new remote runs require publication.
