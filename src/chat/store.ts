import { eq, asc, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { chatSessions, chatMessages, type ChatSession, type ChatMessage } from "../db/schema.js";

export async function createSession(title?: string, model = "sonnet", projectId?: string | null): Promise<ChatSession> {
  const [row] = await db.insert(chatSessions).values({
    title: title ?? "New chat",
    model,
    projectId: projectId ?? null,
  }).returning();
  return row;
}

export async function listSessions(): Promise<ChatSession[]> {
  return db.select().from(chatSessions).orderBy(desc(chatSessions.createdAt));
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  return row;
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  return db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt));
}

export async function appendMessage(m: {
  sessionId: string;
  role: string;
  body: string;
  toolCalls?: ChatMessage["toolCalls"];
}): Promise<ChatMessage> {
  const [row] = await db.insert(chatMessages).values({
    sessionId: m.sessionId,
    role: m.role,
    body: m.body,
    toolCalls: m.toolCalls ?? null,
  }).returning();
  return row;
}

export async function updateSessionRuntime(
  id: string,
  patch: { sdkSessionId?: string; model?: string }
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (patch.sdkSessionId !== undefined) updates.sdkSessionId = patch.sdkSessionId;
  if (patch.model !== undefined) updates.model = patch.model;
  if (Object.keys(updates).length === 0) return;
  await db.update(chatSessions).set(updates).where(eq(chatSessions.id, id));
}

export async function deleteSession(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(chatMessages).where(eq(chatMessages.sessionId, id));
    await tx.delete(chatSessions).where(eq(chatSessions.id, id));
  });
}
