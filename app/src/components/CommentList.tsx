import type { Comment } from "../api/types.js";
import { Avatar } from "./Avatar.js";

export function CommentList({ items, actorName }: { items: Comment[] | undefined; actorName: (id: string) => string }) {
  return (
    <div className="space-y-4">
      {items?.map(c => (
        <div key={c.id} className="flex gap-4">
          <Avatar actorId={c.authorId} size="lg" />
          <div className="flex-1 glass-card p-4 rounded-xl space-y-2">
            <div className="flex justify-between items-center gap-4">
              <span className="font-body-sm font-bold text-primary">{actorName(c.authorId)}</span>
              <span className="font-code-sm text-[11px] opacity-40 shrink-0">
                {new Date(c.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm text-on-surface-variant whitespace-pre-wrap">{c.body}</p>
          </div>
        </div>
      ))}
      {(!items || items.length === 0) && (
        <p className="text-on-surface-variant text-xs opacity-50 italic text-center py-4">No comments yet</p>
      )}
    </div>
  );
}
