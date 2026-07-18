import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { projects } from "../api/projects.js";
import { tickets } from "../api/tickets.js";
import { pickFolder, dialogAvailable } from "../lib/native-dialog.js";
import { useProject } from "../context/project.js";

type DoctorStatus = { name: string; binary: string; probe: { ok: boolean; error?: string } };

export function Wizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [canBrowse, setCanBrowse] = useState(false);
  const { setActiveProject, refreshProjects } = useProject();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [createErr, setCreateErr] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const docQ = useQuery({ queryKey: ["doctor"], queryFn: () => api.get("/forge/doctor?fresh=true"), enabled: step === 2 });
  const [bootstrapErr, setBootstrapErr] = useState("");

  const [title, setTitle] = useState("Build my first feature");
  const [body, setBody] = useState("Add a simple hello world endpoint.");
  const [ticketErr, setTicketErr] = useState("");

  useEffect(() => { dialogAvailable().then(setCanBrowse); }, []);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateErr("");
    setIsSubmitting(true);
    try {
      const p = await projects.create({ name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") });
      if (path) await api.patch(`/projects/${p.id}`, { repoPath: path });
      await refreshProjects();
      setActiveProject(p.id);
      setStep(2);
    } catch (err: any) {
      setCreateErr(err.message || "Failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBootstrap = async () => {
    setBootstrapErr("");
    setIsSubmitting(true);
    try {
      await api.post("/relay/bootstrap");
      setStep(3);
    } catch (err: any) {
      if (err.message && err.message.includes("409")) setStep(3);
      else setBootstrapErr(err.message || "Failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setTicketErr("");
    setIsSubmitting(true);
    try {
      const projs = await projects.list();
      const project = projs.find(p => p.key !== "inbox") || projs[0];
      const t = await tickets.create({ projectId: project.id, title, body, status: "planned", priority: "high" });
      onComplete();
      navigate({ to: "/forge" });
    } catch (err: any) {
      setTicketErr(err.message || "Failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="glass-card p-8 max-w-lg w-full flex flex-col gap-6">
        <h2 className="text-2xl font-bold text-primary">Welcome to VibeOps</h2>
        {step === 1 && (
          <form onSubmit={handleCreateProject} className="flex flex-col gap-4">
            <p className="text-on-surface-variant">Step 1: Let's set up your first project workspace.</p>
            <input required placeholder="Project Name" value={name} onChange={e => setName(e.target.value)} className="bg-surface-container border border-white/10 p-2 rounded text-on-surface" />
            <div className="flex gap-2">
              <input placeholder="Absolute folder path (optional)" value={path} onChange={e => setPath(e.target.value)} className="bg-surface-container border border-white/10 p-2 rounded text-on-surface flex-1" />
              {canBrowse && <button type="button" onClick={async () => { const dir = await pickFolder(); if (dir) setPath(dir); }} className="px-4 bg-white/10 text-on-surface rounded hover:bg-white/20">Browse</button>}
            </div>
            {createErr && <p className="text-error">{createErr}</p>}
            <button type="submit" disabled={!name || isSubmitting} className="bg-primary text-on-primary py-2 rounded font-bold uppercase tracking-widest disabled:opacity-50">Create Project</button>
          </form>
        )}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <p className="text-on-surface-variant">Step 2: Detecting local agent CLIs for your pipeline.</p>
            {docQ.isLoading ? (
              <div className="animate-pulse text-primary-fixed-dim">Detecting agents...</div>
            ) : (
              <div className="flex flex-col gap-2">
                {((docQ.data as DoctorStatus[]) || []).map((s: DoctorStatus) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${s.probe.ok ? "bg-green-500" : "bg-red-500"}`}></span>
                    <span className="text-on-surface">{s.name} ({s.binary})</span>
                  </div>
                ))}
              </div>
            )}
            {bootstrapErr && <p className="text-error">{bootstrapErr}</p>}
            <button onClick={handleBootstrap} disabled={isSubmitting || docQ.isLoading} className="bg-primary text-on-primary py-2 rounded font-bold uppercase tracking-widest disabled:opacity-50">Generate relay.json & Continue</button>
          </div>
        )}
        {step === 3 && (
          <form onSubmit={handleCreateTicket} className="flex flex-col gap-4">
            <p className="text-on-surface-variant">Step 3: Create your first ticket to trigger the Forge.</p>
            <input required placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} className="bg-surface-container border border-white/10 p-2 rounded text-on-surface" />
            <textarea required placeholder="Description" value={body} onChange={e => setBody(e.target.value)} className="bg-surface-container border border-white/10 p-2 rounded text-on-surface min-h-[100px]" />
            {ticketErr && <p className="text-error">{ticketErr}</p>}
            <button type="submit" disabled={!title || !body || isSubmitting} className="bg-primary text-on-primary py-2 rounded font-bold uppercase tracking-widest disabled:opacity-50">Start Building</button>
          </form>
        )}
      </div>
    </div>
  );
}
