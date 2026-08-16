import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { BrowserGrantsCard } from "./BrowserGrantsCard.js";

beforeEach(() => apiFetch.mockReset());

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("lists existing grants and PATCHes on add", async () => {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/settings/browserGrants" && !opts) return { value: '[{"origin":"https://github.com","mode":"act"}]' };
    return {};
  });
  render(<Wrap><BrowserGrantsCard /></Wrap>);
  await waitFor(() => expect(screen.getByText(/https:\/\/github\.com · act/)).toBeInTheDocument());

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://EXAMPLE.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Grant act" }));

  await waitFor(() => {
    const patch = apiFetch.mock.calls.find(([p, o]) => p === "/settings/browserGrants" && o?.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch![1].body.value).toContain("https://example.com");
  });
});
