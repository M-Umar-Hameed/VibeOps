# Finding: PGlite Unclean Exit Behavior

**Date:** 2026-08-12
**Status:** Investigation complete

---

## Summary

PGlite 0.2.17 on Windows NodeFS **survives hard kills via WAL replay**. The ticket's reported `Aborted()` failure could not be reproduced; WAL replay succeeds and all committed rows (both pre- and post-checkpoint) survive.

However, periodic `CHECKPOINT` remains valuable for a different reason: it bounds the window of WAL that must be replayed, reducing startup time after an unclean exit. The mitigation proceeds as originally planned, with this adjusted justification.

---

## Repro Procedure

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

## Analysis

### Why No Abort/PANIC?

The ticket reported:

> Embedded database at ~/.vibeops/data could not be opened: Aborted().

This failure pattern suggests the WASM trap or a PostgreSQL PANIC during recovery. However, on PGlite 0.2.17 with the NodeFS backend:

1. **WAL is durably flushed.** PGlite's NodeFS backend calls `fs.fsyncSync` on WAL writes (confirmed in `@electric-sql/pglite` source: `syncToFs` invokes underlying fsync unless `relaxedDurability: true`).

2. **WAL replay succeeds on open.** The cluster performs standard PostgreSQL recovery, replaying all WAL since the last checkpoint. No WASM trap, no PANIC.

3. **Possible causes for the original failure:**
   - An older PGlite version with a durability bug.
   - A corrupted WAL segment from a partial write (power loss mid-write, not mid-transaction).
   - The `relaxedDurability: true` option (not set in this codebase, `src/db/client.ts:41` shows default options only).
   - A WASM memory limit exceeded during recovery (unlikely at standalone scale).

### Is Checkpoint Still Needed?

Yes, but for a different reason than originally stated.

**Original premise (incorrect):** "On a hard kill the cluster resets to the last checkpoint; max lost work = checkpoint interval."

**Actual behavior:** WAL replay recovers all committed transactions, not just those before the last checkpoint.

**Revised justification:** Periodic `CHECKPOINT` reduces the amount of WAL that must be replayed on startup after an unclean exit. At standalone scale this is seconds, but the mechanism is still correct and costs nothing (sub-second flushes). The 2-minute default is conservative.

---

## Conclusion

1. **Checkpointed state is durable across a hard kill.** ✓
2. **All committed transactions survive via WAL replay.** ✓ (exceeds original expectation)
3. **Periodic CHECKPOINT still reduces recovery time.** Proceed with Task 2.
4. **The ticket's `Aborted()` failure is not reproducible on 0.2.17.** If it recurs, check for `relaxedDurability: true` or version regression.

---

## Appendix: Test Files

- `tests/helpers/hard-kill-repro.mts` — child process for kill testing
- `tests/hard-kill-repro.test.ts` — automated repro confirming WAL replay
