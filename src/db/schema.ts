import {
  pgTable, uuid, text, integer, timestamp, jsonb, pgEnum, index, uniqueIndex, check, vector, boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ticketStatus = pgEnum("ticket_status", ["open", "in_progress", "closed"]);
export const ticketPriority = pgEnum("ticket_priority", ["low", "normal", "high"]);
export const actorKind = pgEnum("actor_kind", ["human", "agent"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actors = pgTable("actors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: actorKind("kind").notNull(),
  role: text("role").notNull().default("member"),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tickets = pgTable("tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: ticketStatus("status").notNull().default("open"),
  priority: ticketPriority("priority").notNull().default("normal"),
  assigneeId: uuid("assignee_id").references(() => actors.id),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ projectIdx: index("tickets_project_idx").on(t.projectId) }));

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  authorId: uuid("author_id").notNull().references(() => actors.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ ticketIdx: index("comments_ticket_idx").on(t.ticketId) }));

// Append-only. No UPDATE, no DELETE, ever. Audits both tickets and notes.
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => actors.id),
  ticketId: uuid("ticket_id").references(() => tickets.id),
  noteId: uuid("note_id").references(() => notes.id),
  action: text("action").notNull(), // e.g. ticket.created, ticket.updated, comment.added
  changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ticketIdx: index("events_ticket_idx").on(t.ticketId),
  target: check("events_target_ck", sql`${t.ticketId} is not null or ${t.noteId} is not null`),
}));

export const noteScope = pgEnum("note_scope", ["global", "project", "ticket"]);
export const sourceKind = pgEnum("source_kind", ["vault", "note", "session"]);

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => actors.id),
  body: text("body").notNull(),
  scope: noteScope("scope").notNull(),
  refId: uuid("ref_id"),
  indexed: boolean("indexed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const embeddings = pgTable("embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceKind: sourceKind("source_kind").notNull(),
  sourceRef: text("source_ref").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  model: text("model").notNull(),
  dim: integer("dim").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  srcIdx: index("embeddings_src_idx").on(t.sourceKind, t.sourceRef),
  uniqChunk: uniqueIndex("embeddings_uniq_chunk").on(t.sourceKind, t.sourceRef, t.chunkIndex),
}));

export const syncLinks = pgTable("sync_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: uniqueIndex("sync_links_uniq").on(t.source, t.externalId) }));

export const syncCommentLinks = pgTable("sync_comment_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  commentId: uuid("comment_id").notNull().references(() => comments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: uniqueIndex("sync_comment_links_uniq").on(t.source, t.externalId) }));

export type Project = typeof projects.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Actor = typeof actors.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type SyncLink = typeof syncLinks.$inferSelect;
export type SyncCommentLink = typeof syncCommentLinks.$inferSelect;

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
