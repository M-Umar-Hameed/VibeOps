export type SessionDoc = {
  ref: string; text: string; hash: string; projectId?: string | null;
  // JSONL sources: bytes consumed up to `offset` of a `size`-byte file; persisted after a successful write.
  cursor?: { offset: number; size: number };
  // true: `text` is only the new bytes since the cursor -> insert, never delete.
  append?: boolean;
};
export interface SessionSource {
  source: string;
  listSessionDocs(sinceDays: number, cursors?: ReadonlyMap<string, number>): Promise<SessionDoc[]>;
}
