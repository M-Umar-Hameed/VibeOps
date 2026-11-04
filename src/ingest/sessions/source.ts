export type SessionDoc = { ref: string; text: string; hash: string; projectId?: string | null };
export interface SessionSource {
  source: string;
  listSessionDocs(sinceDays: number): Promise<SessionDoc[]>;
}
