import { sweepUnindexedNotes } from "./src/services/notes.js"; const done = await sweepUnindexedNotes(); console.log(`Swept ${done} notes.`); process.exit(0);
