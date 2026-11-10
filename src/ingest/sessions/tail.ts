import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

// Window sizes measured against ~2.7 GB of real transcripts: a 256 KB tail
// extracted only 58k chars total, 4 MB extracts 299k for ~23 MB more peak RSS.
// ponytail: incremental offset indexing exists in readJsonlDelta. The fixed-tail
// window applies to first ingest only; thereafter append-only reads grow the index.
export const TAIL_BYTES = 4_194_304;
// Fallback window: a single JSONL record can exceed TAIL_BYTES (observed 1.6 MB
// for large tool outputs). Without this retry such a session yields no complete
// line and would be skipped entirely.
export const MAX_TAIL_BYTES = 16_777_216;

export function readIndexTail(
  path: string,
  maxBytes = TAIL_BYTES,
  retryBytes = MAX_TAIL_BYTES,
): { text: string; hash: string; size: number } | null {
  let size: number, mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const len = Math.min(size, maxBytes);
  const position = size - len;
  const buf = Buffer.alloc(len);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    readSync(fd, buf, 0, len, position);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  let text = buf.toString("utf8");
  if (len < size) {
    const nl = text.indexOf("\n");
    if (nl === -1) {
      return maxBytes >= retryBytes ? null : readIndexTail(path, retryBytes, retryBytes);
    }
    text = text.slice(nl + 1);
  }

  const hash = createHash("sha256").update(`${size}:${mtimeMs}:`).update(buf).digest("hex");
  return { text, hash, size };
}

// Complete lines in [start, size), read in windows of `window` bytes, each cut back to its last "\n".
// end = offset just past the last complete line consumed (== start if none). skipFirst: start is mid-line.
export function readLines(path: string, start: number, size: number, window = MAX_TAIL_BYTES, skipFirst = false):
  { texts: string[]; end: number; hash: string } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  const h = createHash("sha256");
  const texts: string[] = [];
  let pos = start;
  try {
    while (pos < size) {
      const len = Math.min(window, size - pos);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      let from = 0;
      if (skipFirst) {
        const i = buf.indexOf(10);
        if (i === -1) { if (pos + len >= size) break; pos += len; continue; }
        from = i + 1; skipFirst = false;
      }
      const nl = buf.lastIndexOf(10);
      if (nl < from) {
        if (pos + len >= size) break; // trailing line still being written: leave it for the next pass
        // ponytail: a single JSONL record longer than `window` is dropped; raise the window if such records matter.
        pos += len; skipFirst = true; continue;
      }
      const chunk = buf.subarray(from, nl + 1);
      h.update(chunk);
      texts.push(chunk.toString("utf8"));
      pos += nl + 1;
    }
  } catch { return null; } finally { closeSync(fd); }
  return { texts, end: pos, hash: h.digest("hex") };
}

// Append-only JSONL read for session ingest.
// No cursor: today's tail window (first ingest, bounded embed cost); cursor = end of last complete line.
// size > cursor: complete lines from the cursor. size < cursor (rewritten/truncated): resume from the tail, nothing deleted.
// size == cursor: null (unchanged).
export function readJsonlDelta(path: string, cursor: number | undefined, tailBytes = TAIL_BYTES, windowBytes = MAX_TAIL_BYTES):
  { texts: string[]; hash: string; offset: number; size: number; append: boolean } | null {
  if (cursor === undefined) {
    const t = readIndexTail(path, tailBytes);
    if (!t) return null;
    const tailPartial = t.text.slice(t.text.lastIndexOf("\n") + 1);
    return { texts: [t.text], hash: t.hash, offset: t.size - Buffer.byteLength(tailPartial, "utf8"), size: t.size, append: false };
  }
  let size: number;
  try { size = statSync(path).size; } catch { return null; }
  if (size === cursor) return null;
  const start = size < cursor ? Math.max(0, size - tailBytes) : cursor;
  const d = readLines(path, start, size, windowBytes, size < cursor && start > 0);
  if (!d || d.end === start) return null;
  return { texts: d.texts, hash: d.hash, offset: d.end, size, append: true };
}

// First maxBytes of the file, cut back to the last complete line (whole file if smaller).
export function readHead(path: string, maxBytes = 1_048_576): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }

  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    readSync(fd, buf, 0, len, 0);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }

  let text = buf.toString("utf8");
  if (len < size) {
    const nl = text.lastIndexOf("\n");
    if (nl !== -1) text = text.slice(0, nl);
  }
  return text;
}
