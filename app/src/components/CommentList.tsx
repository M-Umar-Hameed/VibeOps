import type { Comment } from "../api/types.js";
export function CommentList({ items, actorName }: { items: Comment[]; actorName: (id: string) => string }) {
  return <ul>{items.map((c) => <li key={c.id}><b>{actorName(c.authorId)}</b>: {c.body}</li>)}</ul>;
}
