# Pipeline overhead: where the time actually goes

Measured 2026-08-21 from `stageDurationsMs` on real runs this session. Written
because a full unattended session produced one commit in eight hours, and doing
four tiers of the browser-control plan by hand took ~40 minutes against the
pipeline's 7 hours for one ticket.

## The measurements

| run | plan | work | review | checks | total |
|---|---|---|---|---|---|
| 446496f3 | 11m | 20m | 1m | 1m | 33m |
| cf2636ac | — | 21m | 1m | 1m | 23m |
| 125f2995 | 3m | 20m | 0m | 0m | 24m |
| 536e4e0c | 2m | 20m | 1m | 1m | 23m |
| 9d0b8b23 | 10m | 13m | 1m | 1m | 25m |
| 3f33b991 | — | 8m | 1m | 1m | 10m |
| adc226a4 | 4m | 4m | 1m | — | 9m |
| c9c0fce1 | — | 5m | 0m | 0m | 6m |
| bddabea1 | 2m | 2m | 0m | 0m | 5m |

## What this kills

**My own hypothesis was wrong.** I assumed review was expensive because it
re-reads the whole diff even for a two-line change. Review costs **0–1 minutes**,
every single time. Checks likewise. Neither is worth optimising.

**Work is the cost.** It is 60–90% of every long run. And the split inside work
is stark: runs where the agent ran the full test suite land at 13–21m; runs where
it did not land at 2–8m. Nothing else explains that bimodality — same models,
same sandboxes, same review.

**The full suite on the serial embedded lane is the overhead.** Docker was
unavailable this session, so `npm test` fell back to `VIBEOPS_TEST_EMBEDDED=1`,
which runs serially at 10–15 minutes versus ~2.5 minutes parallel. Every work
stage that ran it paid that, inside the agent's own budget, before review even
started.

## The largest single fix is a ticket-writing habit, not code

I wrote acceptance criteria demanding "3 full suite runs, paste all 3 tallies"
and "5 consecutive full suite runs". On the serial lane that is 30–75 minutes of
agent time per ticket, and the agent pays it while holding the work stage open.

The suite already runs twice more after the agent finishes: once in `checks`
(1m, concurrent with review) and once when the supervisor gates. Asking the work
agent for it is the third run of the same thing, on the slowest lane, in the most
expensive place.

**Ask the work stage for targeted tests only.** That is already lesson 14 in the
prompt-lessons doc ("Worker runs targeted tests only — the full sweep belongs to
checks and CI"). My ticket ACs overrode the lesson I wrote.

## Ranked fixes

1. **Stop demanding full-suite runs in work-stage ACs.** Free, immediate, and the
   biggest single lever. Targeted tests plus the named mutation is what the work
   stage should prove; breadth belongs to checks and the supervisor.
2. **Keep Docker up — DEV ONLY, not a product concern.** 10–15m → ~2.5m for any
   suite that does run. This applies to developing *this repo*, where the
   parallel test lane needs a real Postgres on :5433. The shipped app never uses
   Docker: it runs embedded PGlite at `~/.vibeops/data`, and users do not run the
   test suite at all. A standalone user's work-stage cost is set by their own
   project's tests, so fix 1 is what generalises — the shape holds (work
   dominates because the agent runs tests), only the magnitude changes.
3. **Do fully-specified small changes directly.** The whole plan→work→review
   ceremony costs 5–33m plus supervisor gating. For a one-line compose fix or a
   guard-key change, that ceremony exceeds the work by an order of magnitude.
   The T1–T4 chain took ~40 minutes by hand including tests and mutations.
4. **Plan reuse already works — do not "fix" it.** A bounced ticket keeps its
   plan (`planned` status skips the plan stage), so retries cost no opus. Several
   rows above have no plan time for exactly this reason. It is the one part of
   the loop that is already efficient.

## What is NOT worth doing

- Optimising review or checks. They are 0–1m. There is nothing there.
- Shrinking the review diff payload. S6's chunking was worth it for correctness
  on oversized diffs, not for speed; review was never the bottleneck.
- Parallelising stages. The stages are already cheap apart from work, and work is
  serial by nature.
