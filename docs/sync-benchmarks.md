# Sync resource measurements

Measured on 1 November 2026, Windows, Node 24.20.0, Intel Core Ultra X7 358H.
All data is synthetic in temporary directories. These are single runs, not
statistical throughput claims or capacity targets. No production provider was
used. SQLite files were measured after closing; peak RSS is the process-wide
`process.resourceUsage().maxRSS`, including both Vaults and the simulator.

## Commands and methodology

```text
node native/benchmark-sync.js 1000 200
node native/benchmark-sync.js 1000 200 --recovery
node native/benchmark-sync.js 2000 200 --recovery
node native/benchmark-sync.js 1000 1000 --recovery
node native/benchmark-resources.js payload
node native/benchmark-resources.js conflicts
```

The history script creates N notes, repeatedly renames the first note E times,
then synchronises to an independent SQLite Vault. It separately times creation,
edits, initial sync and an unchanged sync. `--recovery` explicitly upgrades to
schema 3. The baseline measurement ran the same script against `6849de7` before
implementation; reproducing it requires copying only this benchmark script into
an isolated baseline checkout. Do not downgrade a schema 3 database to compare.

| Implementation / schema | Notes / edits | Create ms | Edit ms | Sync ms | Idle ms | Peak RSS KiB | Source database bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before / 2 | 1000 / 200 | 1664 | 502 | 2736 | 4 | 147588 | 1658880 |
| After / 2 | 1000 / 200 | 1916 | 409 | 2346 | 1 | 103212 | 1667072 |
| After / 3 | 1000 / 200 | 3666 | 912 | 2698 | 1 | 207936 | 2314240 |
| After / 3 | 2000 / 200 | 7653 | 1201 | 4915 | 3 | 343024 | 4214784 |
| After / 3 | 1000 / 1000 | 2905 | 6371 | 6752 | 2 | 334380 | 3436544 |

The schema 2 pair is consistent with less history/checkpoint overhead, but one
run does not establish a general performance improvement. Schema 3 adds durable
requested projections, dependency indexes and whole-tree checks, with measurable
cost. Measurements preceded a final change to read only parent IDs rather than
complete metadata in the tree scan; no speedup is claimed for that small change.

## Large payloads and conflicts

The payload script creates a 1 MiB Yjs text document and a 32 MiB attachment,
transfers both and attempts another full-snapshot edit.
It completed in **8,819 ms**, peaked at **1,047,628 KiB RSS** (about 1 GiB),
and left a **133,152,768-byte** source database. The next edit was rejected by
the 64 MiB per-note history budget. The test exposed a stack overflow in the old
Base64 validation regexp; canonical decode/re-encode validation replaced it.
Regression tests cover a valid large payload and malformed encodings.

The conflicts script applies 64 divergent title operations, retains **2,016**
pairwise conflicts, and leaves **65** deliveries pending for a lagging second
target. It completed in **1,653 ms**, peaked at **152,504 KiB RSS**, and left an
**868,352-byte** source database. This demonstrates retained competing evidence
and independent delivery progress, not a safe maximum conflict count.

## Boundaries and remaining work

Pages are limited by count and encoded bytes; each receive transaction applies
at most 200 ready operations. Indexed dependency lookups avoid decoding the whole
waiting queue. Linear reconciliation avoids ancestor-set construction. Schema 3
rejects more than 1,024 operations or 64 MiB of retained operation JSON per note.
Tests exercise rejection without changed state, 251 delayed operations drained
across a reopen, malformed pages, process termination and index failures.

These limits do not bound total memory or total database size. Full snapshots,
Base64, validation copies and attachment BLOBs remain expensive; even an accepted
32 MiB attachment can consume roughly 1 GiB and prevent further edits. Nonlinear
conflicts can grow quadratically; integrity checks and diagnostic listings still
load substantial history. There is no destructive compaction, automatic recovery
from a reached history budget or large-file production readiness claim.

Before production transport, design chunked payloads, streamed parsing and safe
retention for offline clients, multiple targets, unresolved versions and restored
clones. Benchmark nonlinear histories and larger datasets on both supported CI
platforms. Preserve native backups and source history while developing that work.
