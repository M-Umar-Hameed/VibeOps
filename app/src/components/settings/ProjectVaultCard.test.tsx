import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { ProjectVaultCard } from "./ProjectVaultCard.js";

beforeEach(() => {
  apiFetch.mockReset();
});

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

test("reflects the active project vault path and name", async () => {
  apiFetch.mockResolvedValue({
    projectId: "p1",
    vaultPath: "/home/u/.vibeops/vaults/p1",
    isRunning: true,
    indexedCount: 3,
    lastSync: null,
    error: null,
  });

  render(
    <TestWrapper>
      <ProjectVaultCard projectId="p1" projectName="Acme" />
    </TestWrapper>
  );

  expect(await screen.findByText("/home/u/.vibeops/vaults/p1")).toBeInTheDocument();
  expect(screen.getByText("Acme")).toBeInTheDocument();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/projects/p1/vault"));
});
