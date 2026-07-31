import { useState, type ReactNode } from "react";
import { useImageAttachments } from "./useImageAttachments.js";

export type EffortLevel = "quick" | "standard" | "max";
const EFFORT_TIPS: Record<EffortLevel, string> = {
  quick: "Quick: cheapest models, small fixes.",
  standard: "Standard: cost-optimized routing.",
  max: "Max: best models everywhere.",
};

export type ComposerTicket = { id: string };

type Props = {
  createTicket: (draft: { title: string; body: string }) => Promise<ComposerTicket>;
  launchPipeline: (ticket: ComposerTicket, effort: EffortLevel) => Promise<{ doctorWarnings?: string[] } | void>;
  onCreated: (ticket: ComposerTicket, opts: { ran: boolean; pipelineError: boolean }) => void | Promise<void>;
  submitDisabled?: boolean;
  inlineControls?: ReactNode;
  moreOptions?: ReactNode;
};

export function WorkOrderComposer({ createTicket, launchPipeline, onCreated, submitDisabled, inlineControls, moreOptions }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>("standard");
  const { attachments, attachError, fileInputRef, uploadFiles, removeAttachment, clear, markdown } = useImageAttachments();

  const create = async (): Promise<ComposerTicket | null> => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    setError("");
    try {
      const [title, ...rest] = trimmed.split("\n");
      const briefBody = rest.join("\n");
      const attachMd = markdown();
      const body = attachMd ? (briefBody ? `${briefBody}\n\n${attachMd}` : attachMd) : briefBody;
      const t = await createTicket({ title: title.slice(0, 200), body });
      setText("");
      clear();
      return t;
    } catch (e: any) {
      setError(e.message || "Failed to create task");
      return null;
    }
  };

  const saveDraft = async () => {
    setCreating(true);
    try {
      const t = await create();
      if (t) await onCreated(t, { ran: false, pipelineError: false });
    } finally {
      setCreating(false);
    }
  };

  const runIt = async () => {
    setCreating(true);
    setWarnings([]);
    try {
      const t = await create();
      if (!t) return;
      let pipelineError = false;
      try {
        const res = await launchPipeline(t, effort);
        if (res && res.doctorWarnings?.length) setWarnings(res.doctorWarnings);
      } catch (e: any) {
        setError(e.message || "Pipeline start failed");
        pipelineError = true;
      }
      await onCreated(t, { ran: true, pipelineError });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        className="w-full bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none min-h-[96px] resize-y"
        aria-label="Work order description"
        placeholder="Describe the work. First line becomes the title."
        value={text}
        onChange={e => setText(e.target.value)}
        onPaste={e => {
          const imgs = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
          if (imgs.length) { e.preventDefault(); uploadFiles(imgs); }
        }}
      />
      <div className="flex items-center flex-wrap gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Effort">
          {(["quick", "standard", "max"] as const).map(lvl => (
            <button
              key={lvl}
              onClick={() => setEffort(lvl)}
              aria-pressed={effort === lvl}
              title={EFFORT_TIPS[lvl]}
              className={`px-3 py-1 rounded-full text-xs capitalize cursor-pointer border transition-colors ${effort === lvl ? "bg-primary text-on-primary border-primary" : "border-white/10 text-on-surface-variant hover:bg-white/5"}`}
            >
              {lvl}
            </button>
          ))}
        </div>
        {inlineControls}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={runIt}
          disabled={creating || submitDisabled || !text.trim()}
          className="flex-1 px-3 py-2 rounded bg-primary hover:brightness-110 text-on-primary text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
        >
          Run it
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Attach image"
          className="px-3 py-2 rounded border border-white/10 hover:bg-white/5 text-on-surface-variant text-xs cursor-pointer"
        >
          Attach
        </button>
      </div>
      <button
        onClick={saveDraft}
        disabled={creating || submitDisabled || !text.trim()}
        className="w-full px-3 py-1 text-on-surface-variant/70 hover:text-on-surface text-xs cursor-pointer disabled:opacity-50"
      >
        Save as draft
      </button>
      {moreOptions}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={e => { uploadFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map(a => (
            <div key={a.id} className="relative">
              <img src={a.previewUrl} alt={a.name} className="w-12 h-12 object-cover rounded border border-white/10" />
              <button
                onClick={() => removeAttachment(a.id)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-error text-white text-[10px] leading-none flex items-center justify-center cursor-pointer"
                aria-label={`Remove ${a.name}`}
              >×</button>
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="flex items-start justify-between gap-2 text-amber-400 text-xs border border-amber-500/30 bg-amber-500/10 rounded p-2">
          <span>{warnings.join("; ")}</span>
          <button onClick={() => setWarnings([])} aria-label="Dismiss warnings" className="cursor-pointer shrink-0">×</button>
        </div>
      )}
      {attachError && <div className="text-error text-xs">{attachError}</div>}
      {error && <div className="text-error text-xs">{error}</div>}
    </div>
  );
}
