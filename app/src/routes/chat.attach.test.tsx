import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const ABS = "/mock/path/shot.png";
const apiFetch = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: {
    get: (p: string) => apiFetch(p, { method: "GET" }),
    post: (p: string, b?: unknown) => apiFetch(p, { method: "POST", body: b }),
    patch: (p: string, b?: unknown) => apiFetch(p, { method: "PATCH", body: b }),
    del: (p: string, b?: unknown) => apiFetch(p, { method: "DELETE", body: b }),
  },
}));

vi.mock("../context/project.js", () => ({
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({
    activeProjectId: "p1",
    projects: [{ id: "p1", name: "Project One" }],
    setActiveProject: () => {},
    refreshProjects: async () => {},
  }),
}));

import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ChatScreen } from "./chat.js";

const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => {
  apiFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

const sess = { id: "s1", title: "Mine", model: "sonnet", projectId: "p1", createdAt: "2026-01-01T00:00:00Z" };

test("pasting an image uploads it and the sent body ends with its markdown", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions") return [sess];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1") return { session: sess, messages: [] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "idle" };
    if (path === "/forge/attachments") return { path: ABS, markdown: `![shot.png](${ABS})` };
    if (path === "/chat/sessions/s1/messages") return { ok: true };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Mine"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/output"), expect.anything()));

  const textarea = screen.getByPlaceholderText(/Type a message/i);
  const file = new File(["dummy"], "shot.png", { type: "image/png" });
  fireEvent.paste(textarea, { clipboardData: { files: [file] } });
  await screen.findByRole("img");

  fireEvent.change(textarea, { target: { value: "check this out" } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/chat/sessions/s1/messages", expect.objectContaining({ method: "POST" })));
  const sendCall = apiFetch.mock.calls.find((c: any) => c[0] === "/chat/sessions/s1/messages");
  const sentBody = sendCall![1].body.body as string;
  expect(sentBody.endsWith(`![shot.png](${ABS})`)).toBe(true);
  expect(sentBody.startsWith("check this out")).toBe(true);
});

test("Send is enabled with only an attachment and no typed text", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions") return [sess];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1") return { session: sess, messages: [] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "idle" };
    if (path === "/forge/attachments") return { path: ABS, markdown: `![shot.png](${ABS})` };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Mine"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/output"), expect.anything()));

  const sendButton = screen.getByRole("button", { name: /^send$/i });
  expect(sendButton).toBeDisabled();

  const textarea = screen.getByPlaceholderText(/Type a message/i);
  const file = new File(["dummy"], "shot.png", { type: "image/png" });
  fireEvent.paste(textarea, { clipboardData: { files: [file] } });
  await screen.findByRole("img");

  expect(sendButton).not.toBeDisabled();
});
