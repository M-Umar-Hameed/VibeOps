// Serial embedded PGlite test lane guard. PG-only files (raw postgres-js sql,
// PG_BASE, allocateSlice, spawned servers needing :5433) are skipped under it.
// Grep EMBEDDED-SKIP / skipIf(EMBEDDED) to find them.
export const EMBEDDED = process.env.VIBEOPS_TEST_EMBEDDED === "1";
// EMBEDDED-SKIP: needs Postgres :5433; not runnable on serial PGlite lane
