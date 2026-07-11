import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { tickets } from "../api/tickets.js";
import { Avatar } from "../components/Avatar.js";

export function CreateScreen() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const pq = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assigneeId, setAssigneeId] = useState("");

  const createTicket = useMutation({
    mutationFn: () => tickets.create({ projectId, title, body, priority, assigneeId: assigneeId || undefined }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["tickets"] }); nav({ to: "/tickets/$id", params: { id: t.id } }); },
  });

  return (
    <div className="w-full max-w-3xl glass-card rounded-lg p-8 relative overflow-hidden mx-auto mt-8">
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-primary-fixed-dim via-transparent to-transparent opacity-50"></div>
      
      <div className="mb-10 text-center">
        <h2 className="font-code-label text-2xl text-primary-fixed-dim tracking-[0.2em] uppercase terminal-cursor">INITIALIZE_NEW_TICKET</h2>
        <div className="h-[1px] w-24 bg-primary-fixed-dim/30 mx-auto mt-4"></div>
      </div>
      
      <form className="space-y-8" onSubmit={(e) => { e.preventDefault(); createTicket.mutate(); }}>
        {/* Title */}
        <div className="space-y-2 group">
          <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
            Title_String
          </label>
          <div className="relative flex items-center">
            <span className="absolute left-4 font-code-label text-primary-fixed-dim opacity-70 font-bold">&gt;</span>
            <input 
              className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 pl-10 pr-4 py-4 font-code-label text-primary-fixed-dim rounded-sm transition-all duration-300 outline-none" 
              placeholder="Define process scope..." 
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
        </div>

        {/* Priority & Assignee & Project Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Project */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Project_ID
            </label>
            <div className="relative">
              <select 
                className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                required
              >
                <option className="bg-surface text-on-surface-variant" value="">Select target namespace</option>
                {pq.data?.map((p) => <option className="bg-surface" key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
            </div>
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Priority_Level
            </label>
            <div className="relative">
              <select 
                className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option className="bg-surface text-on-surface-variant" value="low">LOW_LATENCY</option>
                <option className="bg-surface text-primary-fixed-dim" value="normal">NORMAL_FLOW</option>
                <option className="bg-surface text-secondary-fixed-dim" value="high">HIGH_PRIORITY</option>
                <option className="bg-surface text-error" value="critical">CRITICAL_BLOCKER</option>
              </select>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
            </div>
          </div>

          {/* Assignee */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Operator_Assign
            </label>
            <div className="relative flex items-center gap-2">
              <Avatar actorId={assigneeId} size="md" />
              <div className="relative flex-1">
                <select 
                  className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer"
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                >
                  <option className="bg-surface" value="">@unassigned_node</option>
                  {aq.data?.map((a) => <option className="bg-surface" key={a.id} value={a.id}>@{a.name}</option>)}
                </select>
                <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
              </div>
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Sys_Description
            </label>
            <span className="font-code-sm text-primary-fixed-dim/40 text-[10px]">MD_SUPPORTED</span>
          </div>
          <div className="relative">
            <textarea 
              className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 p-6 font-code-label text-on-surface rounded-sm transition-all duration-300 resize-y outline-none" 
              placeholder="Describe the operational anomaly or requirement here..." 
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            ></textarea>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pt-6 border-t border-white/5">
          <button 
            type="button"
            onClick={() => nav({ to: "/" })}
            className="group flex items-center gap-2 px-6 py-2 text-on-surface-variant hover:text-error transition-all duration-300 cursor-pointer"
          >
            <span className="material-symbols-outlined text-lg group-hover:rotate-90 transition-transform">close</span>
            <span className="font-code-label text-code-label tracking-widest uppercase">ABORT_CANCEL</span>
          </button>
          
          <button 
            type="submit"
            disabled={!projectId || !title || createTicket.isPending}
            className="w-full sm:w-auto px-10 py-4 bg-primary-fixed-dim text-on-primary font-code-label text-code-label font-bold uppercase tracking-[0.15em] rounded-sm neon-glow-primary hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-3 cursor-pointer"
          >
            <span className="material-symbols-outlined">bolt</span>
            EXECUTE_SUBMIT
          </button>
        </div>
      </form>

      <div className="absolute bottom-4 left-8 pointer-events-none opacity-20">
        <span className="font-code-sm text-[9px] uppercase tracking-tighter">Instance_ID: {Math.floor(Math.random() * 900) + 100}-VBO-{Math.floor(Math.random() * 90) + 10} | TS: {new Date().toISOString().substring(0, 19).replace('T', ' ')}</span>
      </div>
    </div>
  );
}
