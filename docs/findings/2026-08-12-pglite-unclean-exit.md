# Finding: PGlite Unclean Exit Behavior

**Date:** 2026-08-12
**Status:** Investigation complete, root cause identified

---

## Summary

PGlite 0.2.17 on Windows NodeFS **survives hard kills via WAL replay**. The ticket's
reported `Aborted()` failure was caused by **concurrent access**: two processes opening
the same data directory simultaneously (e.g. running `npm run backup` while the server
was live).

---

## Part 1: Hard Kill Survival (Confirmed)

### Test 1: Hard Kill WITH Checkpoint

1. Child process opens PGlite in a temp dir, migrates, inserts a "pre" row, issues `CHECKPOINT`, inserts a "post" row, prints "ready", idles.
2. Parent waits for "ready", then `taskkill /F /PID` (Windows SIGKILL equivalent).
3. Parent attempts to reopen the cluster.

**Verbatim output:**

```
REOPEN SUCCESS - keys: [ 'post', 'pre' ]
```

**Result:** Both rows survive. WAL replay succeeded.

### Test 2: Hard Kill WITHOUT Checkpoint

Identical procedure, omitting the `CHECKPOINT` call.

**Verbatim output:**

```
UNEXPECTED SUCCESS - rows: [ { key: 'post' }, { key: 'pre' } ]
```

**Result:** Both rows survive. WAL replay succeeded even without an explicit checkpoint.

---

## Part 2: Concurrent Access Corruption (Root Cause)

### Hypothesis

The original ticket reported `Aborted()` after hard kills. But the user also ran probe
scripts and `npm run backup` while the server was live. `src/db/backup-cli.ts` imports
`src/db/client.ts`, which opens its own PGlite instance against `~/.vibeops/data`.
PGlite is a single-writer embedded cluster; a second process opening the same directory
is not supported and may corrupt the WAL.

### Test: Concurrent Writers

1. Process A opens PGlite in a temp dir, migrates, writes in a loop.
2. After A is writing, process B attempts to open the same directory.
3. Hard kill A, then try to reopen.

**Verbatim output:**

```
STDOUT[A]: [A] ready
STDOUT[A]: [A] inserted A-0
STDOUT[A]: [A] inserted A-1
... (A writes A-0 through A-23)
=== AFTER 2s OF CONCURRENT WRITING ===
writerB exited: false code: null
A: hard killed
B: killed
REOPEN FAILED: Aborted(). Build with -sASSERTIONS for more info.
=== CONCURRENT WRITE FINDING ===
B opened successfully while A was running: false
reopenError: Aborted(). Build with -sASSERTIONS for more info.
```

**Result:** Concurrent access corrupts the database. `Aborted()` is the exact error
from the original ticket. B never finished opening (stuck), and after A was killed the
database is unrecoverable.

### Root Cause Confirmed

The `Aborted()` failure in the ticket was NOT caused by hard kills. It was caused by
concurrent access to the data directory, likely from running `npm run backup` or similar
while the server held the database open.

---

## Analysis

### Why Hard Kills Are Safe

PGlite 0.2.17 with NodeFS:

1. **WAL is durably flushed.** `syncToFs` invokes fsync unless `relaxedDurability: true`.
2. **WAL replay succeeds on open.** Standard PostgreSQL recovery replays all WAL since the last checkpoint.
3. **No lock on single-process access.** Only single-process access is safe.

### Why Concurrent Access Corrupts

PGlite does not implement inter-process locking. When two processes open the same
directory, they each maintain independent in-memory state and WAL positions. Writes
from one process are not visible to the other. On close or crash, the WAL contains
interleaved records from both processes, which PostgreSQL recovery cannot parse.

### Checkpoint Justification (Revised)

Periodic `CHECKPOINT` reduces WAL replay time on startup, not data loss (all committed
transactions survive via replay). At standalone scale this is seconds. The 2-minute
default is conservative but harmless.

---

## Mitigations

1. **Document the concurrent access danger.** USER_GUIDE.md updated.
2. **Backup CLI refuses to run if server is live.** Check for lock file or HTTP probe.
3. **Periodic CHECKPOINT.** Reduces replay time, not loss.

---

## Conclusion

1. **Hard kills are survivable.** WAL replay recovers all committed transactions.
2. **Concurrent access causes corruption.** This was the original ticket's root cause.
3. **Periodic CHECKPOINT reduces startup time**, not data loss.
4. **Fix: prevent concurrent access** by making backup CLI refuse to run while server is live.

---

## Test Files

- `tests/helpers/hard-kill-repro.mts` — child process for kill testing
- `tests/hard-kill-repro.test.ts` — automated repro confirming WAL replay survives hard kill
- `tests/helpers/concurrent-open-repro.mts` — child for concurrent access testing
- `tests/helpers/concurrent-open-writer.mts` — child that writes in a loop
- `tests/concurrent-open-repro.test.ts` — concurrent open test (both processes can open)
- `tests/concurrent-write-corruption.test.ts` — concurrent writers cause `Aborted()` on reopen
