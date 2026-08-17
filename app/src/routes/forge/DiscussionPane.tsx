import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { CommentList } from "../../components/CommentList.js";
import type { Ticket } from "./types.js";

type DiscussionPaneProps = {
  selectedTicket: Ticket;
  actors: any[];
  onTicketUpdated: (ticket: Ticket) => void;
};

export function DiscussionPane({ selectedTicket, actors, onTicketUpdated }: DiscussionPaneProps) {
  const queryClient = useQueryClient();
  const [commentInput, setCommentInput] = useState("");
  const [commentError, setCommentError] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);

  useEffect(() => {
    setCommentInput("");
    setCommentError("");
  }, [selectedTicket.id]);

  const commentsQ = useQuery({
    queryKey: ["tickets", selectedTicket.id, "comments"],
    queryFn: () => api.get(`/tickets/${selectedTicket.id}/comments`),
  });
  const ticketComments = Array.isArray(commentsQ.data) ? commentsQ.data : [];

  const actorName = (aid: string) => actors.find((a: any) => a.id === aid)?.name ?? aid;

  const handlePostComment = async () => {
    if (!selectedTicket || !commentInput.trim()) return;
    setPostingComment(true);
    setCommentError("");
    try {
      await api.post(`/tickets/${selectedTicket.id}/comments`, { body: commentInput });
      setCommentInput("");
      await queryClient.invalidateQueries({ queryKey: ["tickets", selectedTicket.id, "comments"] });
    } catch (e: any) {
      setCommentError(e.message || "Failed to post comment");
    } finally {
      setPostingComment(false);
    }
  };

  const handleRequestChanges = async () => {
    if (!selectedTicket || !commentInput.trim()) return;
    setRequestingChanges(true);
    setCommentError("");
    try {
      const body = `CHANGE REQUEST:\n${commentInput}`;
      await api.post(`/tickets/${selectedTicket.id}/comments`, { body });
      if (selectedTicket.status === "review") {
        const updated = await api.patch(`/tickets/${selectedTicket.id}`, { 
          expectedVersion: selectedTicket.version, 
          status: "planned" 
        });
        await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
        onTicketUpdated(updated as Ticket);
      } else {
        await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
      }
      setCommentInput("");
      await queryClient.invalidateQueries({ queryKey: ["tickets", selectedTicket.id, "comments"] });
    } catch (e: any) {
      setCommentError(e.message || "Failed to request changes");
    } finally {
      setRequestingChanges(false);
    }
  };

  return (
    <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
      <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Discussion</h3>
      <CommentList items={ticketComments} actorName={actorName} />
      
      <div className="relative mt-4">
        <textarea 
          className="w-full bg-surface-container-lowest border border-white/10 rounded-xl p-4 text-sm text-on-surface focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/30 outline-none transition-all min-h-[100px] resize-y pb-12" 
          placeholder="Type your comment... prefix with CHANGE REQUEST: or use the button."
          value={commentInput}
          onChange={(e) => setCommentInput(e.target.value)}
        />
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button 
            className="px-4 py-2 bg-surface-container border border-white/10 hover:bg-white/5 text-on-surface font-bold text-sm rounded transition-transform active:scale-95 disabled:opacity-50 cursor-pointer"
            disabled={!commentInput.trim() || postingComment || requestingChanges || (selectedTicket.status !== "review" && selectedTicket.status !== "planned")}
            onClick={handleRequestChanges}
            title="Enabled when status is review or planned"
          >
            Request changes
          </button>
          <button 
            className="px-4 py-2 bg-primary text-on-primary font-bold text-sm rounded transition-transform active:scale-95 shadow-[0_0_15px_rgba(0,219,233,0.3)] disabled:opacity-50 cursor-pointer"
            disabled={!commentInput.trim() || postingComment || requestingChanges}
            onClick={handlePostComment}
          >
            Post comment
          </button>
        </div>
      </div>
      {commentError && <div className="text-error text-xs">{commentError}</div>}
    </div>
  );
}
