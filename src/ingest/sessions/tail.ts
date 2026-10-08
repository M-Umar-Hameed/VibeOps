import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

// Window sizes measured against ~2.7 GB of real transcripts: a 256 KB tail
// extracted only 58k chars total, 4 MB extracts 299k for ~23 MB more peak RSS.
// ponytail: a fixed tail still indexes only the END of a long session. Transcripts
// are mostly tool-call JSON that extractText discards, so recovering full recall
// needs incremental offset-based indexing, not a larger window.
export const TAIL_BYTES = 4_194_304;
// Fallback window: a single JSONL record can exceed TAIL_BYTES (observed 1.6 MB
// for large tool outputs). Without this retry such a session yields no complete
// line and would be skipped entirely.
export const MAX_TAIL_BYTES = 16_777_216;

export function readIndexTail(
  path: string,
  maxBytes = TAIL_BYTES,
  retryBytes = MAX_TAIL_BYTES,
): { text: string; hash: string } | null {
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
  return { text, hash };
}
