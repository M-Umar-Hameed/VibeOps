import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Markdown } from "../components/Markdown.js";
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
  toolCalls?: { name: string; input: unknown; summary: string }[];
  createdAt: string;
};

type SessionDetail = {
  session: ChatSession;
  messages: ChatMessage[];
};

type RosterEntry = { agent: string; toolCapable: boolean; models: { name: string }[] };

export function ChatScreen() {
  const queryClient = useQueryClient();
  const { activeProjectId, projects } = useProject();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>("sonnet");
  const [isSending, setIsSending] = useState(false);
  const [liveOutput, setLiveOutput] = useState("");
  const [error, setError] = useState("");
  const nextOffsetRef = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery<ChatSession[]>({
    queryKey: ["chat", "sessions"],
    queryFn: () => api.get("/chat/sessions") as Promise<ChatSession[]>,
  });

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

  // Legacy 'sonnet'/'opus' (no '::') are the sdk lane and tool-capable.
  const selectedToolCapable =
    !model.includes("::") ||
    roster.some((r) => r.toolCapable && r.models.some((m) => `${r.agent}::${m.name}` === model));

  // Poll for output while sending
  useEffect(() => {
    if (!isSending || !selectedSessionId) return;
    let running = true;
    const poll = async () => {
      try {
        const res = (await api.get(
          `/chat/sessions/${selectedSessionId}/output?after=${nextOffsetRef.current}`
        )) as { chunk: string; next: number; status: string };
        if (!running) return;
        if (res.chunk) {
          setLiveOutput((prev) => prev + res.chunk);
          setTimeout(() => {
            if (outputRef.current) {
              outputRef.current.scrollTop = outputRef.current.scrollHeight;
            }
          }, 10);
        }
        nextOffsetRef.current = res.next;
        if (res.status !== "running") {
          setIsSending(false);
          setLiveOutput("");
          nextOffsetRef.current = 0;
          refetchDetail();
          queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
        }
      } catch {
        // ignore
      }
    };
    const interval = setInterval(poll, 1000);
    poll();
    return () => {
      running = false;
      clearInterval(interval);
    };
  }, [isSending, selectedSessionId, refetchDetail, queryClient]);

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

  const handleSend = async () => {
    if (!selectedSessionId || !input.trim() || isSending) return;
    setError("");
    setIsSending(true);
    setLiveOutput("");
    nextOffsetRef.current = 0;
    try {
      const res = (await api.post(`/chat/sessions/${selectedSessionId}/messages`, {
        body: input,
        model,
      })) as { ok?: boolean; error?: string };
      if (res.error) {
        setError(res.error);
        setIsSending(false);
        return;
      }
      setInput("");
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
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedSessionId(s.id)}
              className={`w-full text-left px-3 py-2 rounded transition-colors ${
                selectedSessionId === s.id
                  ? "bg-primary-fixed-dim/10 text-primary-fixed-dim"
                  : "hover:bg-white/5 text-on-surface-variant"
              }`}
            >
              <div className="truncate text-sm font-medium">{s.title}</div>
              <div className="text-xs opacity-60">
                {projects.find((p) => p.id === s.projectId)?.name ?? "All projects"}
              </div>
              <div className="text-xs opacity-60">
                {new Date(s.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
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
                    {r.models.map((m) => (
                      <option key={`${r.agent}::${m.name}`} value={`${r.agent}::${m.name}`}>
                        {m.name}{r.toolCapable ? " · tools" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Messages */}
            <div ref={outputRef} className="flex-1 overflow-y-auto p-4 space-y-4">
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
                    <div className="mt-2 space-y-1">
                      {m.toolCalls.map((tc, i) => (
                        <details key={i} className="text-xs">
                          <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                            <span className="font-mono">{tc.name}</span> — {tc.summary}
                          </summary>
                          <pre className="mt-1 p-2 bg-black/20 rounded overflow-x-auto text-on-surface-variant">
                            {JSON.stringify(tc.input, null, 2)}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              ))}
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
              {!selectedToolCapable && (detail?.messages?.length ?? 0) === 0 && (
                <div className="mb-2 text-xs text-on-surface-variant">
                  Tools (knowledge search, browser) are unavailable on this model.
                </div>
              )}
              <div className="flex gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  disabled={isSending}
                  rows={2}
                  className="flex-1 bg-surface-container-highest text-on-surface rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={isSending || !input.trim()}
                  className="px-4 py-2 bg-primary text-on-primary rounded font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {isSending ? "..." : "Send"}
                </button>
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
