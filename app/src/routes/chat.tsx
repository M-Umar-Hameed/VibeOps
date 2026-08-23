import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Markdown } from "../components/Markdown.js";
import { ContextMenu, type MenuItemSpec } from "../components/ContextMenu.js";
import { useImageAttachments } from "../components/useImageAttachments.js";
import { useProject } from "../context/project.js";

type ChatSession = {
  id: string;
  title: string;
  model: string;
  projectId?: string | null;
  createdAt: string;
};

type ChatMessage = {
  id: string;
  role: string;
  body: string;
  toolCalls?: { name: string; input: unknown; summary: string; grantOrigin?: string }[];
  createdAt: string;
};

type SessionDetail = {
  session: ChatSession;
  messages: ChatMessage[];
};

type RosterModel = { name: string; toolCapable?: boolean };
type RosterEntry = { agent: string; toolCapable: boolean; models: RosterModel[] };

export function ChatScreen() {
  const queryClient = useQueryClient();
  const { activeProjectId, projects } = useProject();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>("sonnet");
  const [isSending, setIsSending] = useState(false);
  const [liveChunks, setLiveChunks] = useState<string[]>([]);
  const liveOutput = liveChunks.join("");
  // True when the SERVER says a turn is running for this session. isSending
  // alone dies on remount (app restart, session switch), leaving a running
  // turn with no indicator - the original "is chat even working?" bug.
  const [serverRunning, setServerRunning] = useState(false);
  const [error, setError] = useState("");
  const [sessionMenu, setSessionMenu] = useState<{ items: MenuItemSpec[]; x: number; y: number; label: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [grantedOrigins, setGrantedOrigins] = useState<Set<string>>(new Set());
  const [grantingOrigin, setGrantingOrigin] = useState<string | null>(null);
  const nextOffsetRef = useRef(0);
  const { attachments, attachError, fileInputRef, uploadFiles, removeAttachment, clear, markdown: attachmentMarkdown } = useImageAttachments();

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery<ChatSession[]>({
    queryKey: ["chat", "sessions"],
    queryFn: () => api.get("/chat/sessions") as Promise<ChatSession[]>,
  });

  const visibleSessions = sessions.filter(
    (s) => s.projectId == null || s.projectId === activeProjectId
  );

  const { data: roster = [] } = useQuery<RosterEntry[]>({
    queryKey: ["chat", "models"],
    queryFn: () => api.get("/chat/models") as Promise<RosterEntry[]>,
  });

  const { data: detail, refetch: refetchDetail } = useQuery<SessionDetail>({
    queryKey: ["chat", "session", selectedSessionId],
    queryFn: () => api.get(`/chat/sessions/${selectedSessionId}`) as Promise<SessionDetail>,
    enabled: !!selectedSessionId,
  });

  useEffect(() => {
    if (detail?.session?.model) setModel(detail.session.model);
  }, [detail?.session?.model]);

  useEffect(() => {
    setLiveChunks([]);
    nextOffsetRef.current = 0;
    setServerRunning(false); // the probe below re-detects an in-flight turn
  }, [selectedSessionId]);

  // Legacy 'sonnet'/'opus' (no '::') are the sdk lane and tool-capable. Below
  // that, tool capability is the lane's flag OR the selected model's own flag
  // (http lanes are never lane-tool-capable, but individual catalog models can be).
  const selectedToolCapable =
    !model.includes("::") ||
    roster.some((r) => r.models.some((m) => `${r.agent}::${m.name}` === model && (r.toolCapable || m.toolCapable)));

  // Poll output while a turn is active; probe once whenever a session is
  // selected so a turn started before this mount is picked up too.
  useEffect(() => {
    if (!selectedSessionId) return;
    let alive = true;
    const active = isSending || serverRunning;
    const poll = async () => {
      try {
        const res = (await api.get(
          `/chat/sessions/${selectedSessionId}/output?after=${nextOffsetRef.current}`
        )) as { chunk: string; next: number; status: string };
        if (!alive) return;
        const nowRunning = res.status === "running";
        // The server keeps a finished turn's buffer around; appending it while
        // idle painted a second, pulsing copy of the last reply next to the
        // persisted one. Live chunks exist only while a turn is running.
        if (res.chunk && nowRunning) {
          setLiveChunks((prev) => [...prev, res.chunk]);
        }
        nextOffsetRef.current = res.next;
        if (nowRunning !== serverRunning) setServerRunning(nowRunning);
        if (!nowRunning && active) {
          setIsSending(false);
          setLiveChunks([]);
          nextOffsetRef.current = 0;
          refetchDetail();
          queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
        }
      } catch {
        // ignore
      }
    };
    poll();
    if (!active) return; // one-shot probe; the setter re-arms the interval if running
    const interval = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [isSending, serverRunning, selectedSessionId, refetchDetail, queryClient]);

  const handleNewChat = async () => {
    setError("");
    try {
      const sess = (await api.post("/chat/sessions", { model, projectId: activeProjectId })) as ChatSession;
      queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
      setSelectedSessionId(sess.id);
    } catch (e: any) {
      setError(e.message || "Failed to create session");
    }
  };

  const handleDeleteSession = async (s: ChatSession) => {
    await api.del(`/chat/sessions/${s.id}`);
    if (selectedSessionId === s.id) setSelectedSessionId(null);
    queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
  };

  const commitRename = async (s: ChatSession) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title || title === s.title) return;
    await api.patch(`/chat/sessions/${s.id}`, { title });
    queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
  };

  const openSessionMenu = (s: ChatSession, x: number, y: number) =>
    setSessionMenu({
      items: [{
        key: "rename", label: "Rename",
        onSelect: () => { setRenamingId(s.id); setRenameValue(s.title); },
      }, {
        key: "delete", label: "Delete chat", danger: true,
        confirm: {
          title: "Delete this chat?",
          message: "Permanently removes the conversation and its indexed transcript. This cannot be undone.",
          confirmLabel: "Delete chat",
        },
        onSelect: () => handleDeleteSession(s),
      }],
      x, y, label: `Actions for ${s.title}`,
    });

  // Origin comes verbatim from the tool-call refusal record (server-sourced), never
  // from assistant prose — a page steering the agent cannot substitute an origin the
  // user did not see. Explicit click only; no auto-approve, no remembered default.
  const handleGrant = async (origin: string) => {
    setError("");
    setGrantingOrigin(origin);
    try {
      await api.post("/browser/grants", { origin });
      setGrantedOrigins((s) => new Set(s).add(origin));
    } catch (e: any) {
      setError(e.message || "Failed to grant");
    } finally {
      setGrantingOrigin(null);
    }
  };

  const handleSend = async () => {
    if (!selectedSessionId || (!input.trim() && attachments.length === 0) || isSending) return;
    setError("");
    setIsSending(true);
    setLiveChunks([]);
    nextOffsetRef.current = 0;
    const body = attachments.length ? `${input}\n\n${attachmentMarkdown()}` : input;
    try {
      const res = (await api.post(`/chat/sessions/${selectedSessionId}/messages`, {
        body,
        model,
      })) as { ok?: boolean; error?: string };
      if (res.error) {
        setError(res.error);
        setIsSending(false);
        return;
      }
      setInput("");
      clear();
    } catch (e: any) {
      setError(e.message || "Failed to send message");
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full gap-4">
      {/* Session list */}
      <div className="w-64 shrink-0 flex flex-col bg-surface-container rounded-lg p-4">
        <button
          onClick={handleNewChat}
          className="w-full mb-4 py-2 px-4 bg-primary text-on-primary rounded hover:opacity-90 font-medium"
        >
          New Chat
        </button>
        {sessionsLoading && <p className="text-on-surface-variant text-sm">Loading...</p>}
        <div className="flex-1 overflow-y-auto space-y-1">
          {visibleSessions.map((s) => (
            <div
              key={s.id}
              onContextMenu={(e) => { e.preventDefault(); openSessionMenu(s, e.clientX, e.clientY); }}
              className="relative"
            >
              <button
                onClick={() => setSelectedSessionId(s.id)}
                className={`w-full text-left px-3 py-2 pr-8 rounded transition-colors ${
                  selectedSessionId === s.id
                    ? "bg-primary-fixed-dim/10 text-primary-fixed-dim"
                    : "hover:bg-white/5 text-on-surface-variant"
                }`}
              >
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${s.title}`}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") { e.preventDefault(); commitRename(s); }
                      if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                    }}
                    onBlur={() => commitRename(s)}
                    className="w-full bg-surface-container-highest text-on-surface rounded px-1 py-0.5 text-sm border border-primary/40 focus:outline-none"
                  />
                ) : (
                  <div className="truncate text-sm font-medium">{s.title}</div>
                )}
                <div className="text-xs opacity-60">
                  {projects.find((p) => p.id === s.projectId)?.name ?? "All projects"}
                </div>
                <div className="text-xs opacity-60">
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </button>
              <button
                type="button"
                aria-label={`Actions for ${s.title}`}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openSessionMenu(s, r.right, r.bottom); }}
                className="absolute top-1 right-1 px-1 text-on-surface-variant hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-lg">more_vert</span>
              </button>
            </div>
          ))}
        </div>
        {sessionMenu && <ContextMenu {...sessionMenu} onClose={() => setSessionMenu(null)} />}
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col bg-surface-container rounded-lg overflow-hidden">
        {selectedSessionId ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <h2 className="font-headline-sm text-on-surface">
                {detail?.session?.title || "Chat"}
              </h2>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bg-surface-container-highest text-on-surface rounded px-2 py-1 text-sm border border-white/10"
              >
                {roster.length === 0 && (
                  <>
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                  </>
                )}
                {roster.map((r) => (
                  <optgroup key={r.agent} label={r.toolCapable ? `${r.agent} · tools` : r.agent}>
                    {r.models.map((m) => {
                      const toolCapable = m.toolCapable ?? r.toolCapable;
                      return (
                        <option key={`${r.agent}::${m.name}`} value={`${r.agent}::${m.name}`}>
                          {m.name}{toolCapable ? " · tools" : ""}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {detail?.messages?.map((m) => (
                <div
                  key={m.id}
                  className={`${
                    m.role === "user"
                      ? "ml-auto bg-primary/10 max-w-[80%]"
                      : "mr-auto bg-surface-container-highest max-w-[90%]"
                  } rounded-lg p-3`}
                >
                  {m.role === "assistant" ? (
                    <Markdown text={m.body} />
                  ) : (
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  )}
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div data-testid="tool-trace" className="mt-2 space-y-1">
                      {m.toolCalls.map((tc, i) => (
                        <div key={i} data-testid="tool-trace-entry">
                          <div className="text-xs text-on-surface-variant">
                            <span className="font-mono">{tc.name}</span> — {tc.summary}
                          </div>
                          {tc.grantOrigin && (
                            grantedOrigins.has(tc.grantOrigin) ? (
                              <p className="mt-1 text-xs text-primary">
                                Granted browser actions on {tc.grantOrigin}. Send again to retry.
                              </p>
                            ) : (
                              <button
                                onClick={() => handleGrant(tc.grantOrigin!)}
                                disabled={grantingOrigin === tc.grantOrigin}
                                className="mt-1 px-3 py-1 rounded bg-primary text-on-primary text-xs font-medium disabled:opacity-50"
                              >
                                Allow browser actions on {tc.grantOrigin}
                              </button>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {(isSending || serverRunning) && !liveOutput && (
                <div
                  data-testid="chat-pending"
                  className="mr-auto bg-surface-container-highest max-w-[90%] rounded-lg p-3 flex items-center gap-2 text-on-surface-variant"
                >
                  <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                  <span className="text-sm">Working...</span>
                </div>
              )}
              {liveOutput && (
                <div className="mr-auto bg-surface-container-highest max-w-[90%] rounded-lg p-3 animate-pulse">
                  <Markdown text={liveOutput} />
                </div>
              )}
            </div>

            {/* Input */}
            <div className="p-4 border-t border-white/10">
              {error && (
                <div className="mb-2 text-error text-sm">{error}</div>
              )}
              {!selectedToolCapable && (
                <div className="mb-2 text-xs text-on-surface-variant">
                  Tools (knowledge search, browser) are unavailable on this model.
                </div>
              )}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {attachments.map((a) => (
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
              {attachError && <div className="mb-2 text-error text-xs">{attachError}</div>}
              <div className="flex gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={(e) => {
                    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                    if (imgs.length) { e.preventDefault(); uploadFiles(imgs); }
                  }}
                  placeholder="Type a message..."
                  disabled={isSending || serverRunning}
                  rows={2}
                  className="flex-1 bg-surface-container-highest text-on-surface rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSending || serverRunning}
                  aria-label="Attach image"
                  title="Attach image"
                  className="px-3 py-2 rounded border border-white/10 hover:bg-white/5 text-on-surface-variant disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-lg">attach_file</span>
                </button>
                <button
                  onClick={handleSend}
                  disabled={isSending || serverRunning || (!input.trim() && attachments.length === 0)}
                  className="px-4 py-2 bg-primary text-on-primary rounded font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {isSending || serverRunning ? "..." : "Send"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => { uploadFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant">
            Select a chat or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
