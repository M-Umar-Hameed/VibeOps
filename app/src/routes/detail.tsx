import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tickets } from "../api/tickets.js";
import { comments } from "../api/comments.js";
import { history } from "../api/history.js";
import { actors } from "../api/actors.js";
import { StaleVersionError } from "../api/errors.js";
import { AuditTimeline } from "../components/AuditTimeline.js";
import { CommentList } from "../components/CommentList.js";
import { Banner } from "../components/Banner.js";

export function DetailScreen({ id }: { id: string }) {
  const qc = useQueryClient();
  const tq = useQuery({ queryKey: ["ticket", id], queryFn: () => tickets.get(id) });
  const hq = useQuery({ queryKey: ["history", id], queryFn: () => history.get(id) });
  const cq = useQuery({ queryKey: ["comments", id], queryFn: () => comments.list(id) });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const actorName = (aid: string) => aq.data?.find((a) => a.id === aid)?.name ?? aid;

  const [status, setStatus] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  useEffect(() => { if (tq.data && status === undefined) setStatus(tq.data.status); }, [tq.data]);

  const save = useMutation({
    mutationFn: () => tickets.update(id, tq.data!.version, { status }),
    onSuccess: () => { setConflict(false); qc.invalidateQueries({ queryKey: ["ticket", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
    onError: (e) => { if (e instanceof StaleVersionError) { setConflict(true); qc.invalidateQueries({ queryKey: ["ticket", id] }); } },
  });

  const [comment, setComment] = useState("");
  const addComment = useMutation({
    mutationFn: () => comments.add(id, comment),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["comments", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
  });

  if (tq.isLoading) return <div>Loading…</div>;
  if (tq.isError) return <div role="alert">Failed to load ticket</div>;
  const t = tq.data!;
  return (
    <div>
      <h2>{t.title}</h2>
      <p>{t.body}</p>
      {conflict && <Banner kind="warn" message="This ticket changed elsewhere — reloaded; please redo your edit and save again." />}
      <label>Status
        <select value={status ?? t.status} onChange={(e) => setStatus(e.target.value)}>
          <option>open</option><option>in_progress</option><option>closed</option>
        </select>
      </label>
      <button onClick={() => save.mutate()}>Save</button>

      <h3>Comments</h3>
      <CommentList items={cq.data ?? []} actorName={actorName} />
      <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="add comment" />
      <button onClick={() => addComment.mutate()}>Add</button>

      <h3>History</h3>
      <AuditTimeline events={hq.data ?? []} actorName={actorName} />
    </div>
  );
}
