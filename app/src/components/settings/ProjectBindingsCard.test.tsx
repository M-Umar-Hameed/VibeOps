import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { ProjectBindingsCard } from "./ProjectBindingsCard.js";

beforeEach(() => {
  apiFetch.mockReset();
});

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

test("renders inputs from mocked GET settings, Save PUTs the right key/value, clear PUTs empty", async () => {
  apiFetch.mockImplementation(async (path, opts?: any) => {
    if (path === "/projects/p1/settings") return { "github.repo": "owner/testrepo" };
    if (path === "/settings/github.token") return { value: "some-token" };
    if (path === "/sync/p1" && opts?.method === "POST") return { created: 0, updated: 0, skipped: 0, commentsAdded: 0, failed: 0, bindings: 1 };
    return {};
  });

  render(
    <TestWrapper>
      <ProjectBindingsCard
        projectId="p1"
        id="github"
        title="GitHub"
        subtitle="Issues"
        borderColorClass="primary/30"
        icon={<div />}
        bindingKey="github.repo"
        label="Repo"
        globalCredentialKey="github.token"
      />
    </TestWrapper>
  );

  // It should show the bound value
  await waitFor(() => expect(screen.getByText("owner/testrepo")).toBeInTheDocument());
  
  // Click Edit Binding
  fireEvent.click(screen.getByRole("button", { name: "Edit Binding" }));

  // Value should be populated in input
  const input = await screen.findByRole("textbox");
  expect(input).toHaveValue("owner/testrepo");

  // Type new value
  fireEvent.change(input, { target: { value: "owner/newrepo" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/projects/p1/settings/github.repo", {
      method: "PUT",
      body: { value: "owner/newrepo" }
    });
  });

  // Test clear - must re-enter edit mode first
  fireEvent.click(screen.getByRole("button", { name: "Edit Binding" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  
  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/projects/p1/settings/github.repo", {
      method: "PUT",
      body: { value: "" }
    });
  });
});

test("save triggers a sync POST and shows summary", async () => {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/projects/p1/settings") return {};                 // unbound -> edit view
    if (path === "/settings/github.token") return { value: "some-token" };
    if (path === "/projects/p1/settings/github.repo" && opts?.method === "PUT") return {};
    if (path === "/sync/p1" && opts?.method === "POST")
      return { created: 5, updated: 0, skipped: 0, commentsAdded: 0, failed: 0, bindings: 1 };
    return {};
  });

  render(<TestWrapper><ProjectBindingsCard
    projectId="p1" id="github" title="GitHub" subtitle="Issues"
    borderColorClass="primary/30" icon={<div />}
    bindingKey="github.repo" label="Repo" globalCredentialKey="github.token" /></TestWrapper>);

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/projects/p1/settings"));
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "owner/newrepo" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/sync/p1", { method: "POST", body: undefined }));
  await waitFor(() => expect(screen.getByText(/Synced: 5 created/)).toBeInTheDocument());
});

test("Sync now button renders on a bound card and calls the endpoint", async () => {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/projects/p1/settings") return { "github.repo": "owner/testrepo" };
    if (path === "/settings/github.token") return { value: "some-token" };
    if (path === "/sync/p1" && opts?.method === "POST")
      return { created: 0, updated: 2, skipped: 1, commentsAdded: 0, failed: 0, bindings: 1 };
    return {};
  });

  render(<TestWrapper><ProjectBindingsCard
    projectId="p1" id="github" title="GitHub" subtitle="Issues"
    borderColorClass="primary/30" icon={<div />}
    bindingKey="github.repo" label="Repo" globalCredentialKey="github.token" /></TestWrapper>);

  await waitFor(() => expect(screen.getByText("owner/testrepo")).toBeInTheDocument());
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/sync/p1", { method: "POST", body: undefined }));
  await waitFor(() => expect(screen.getByText(/2 updated/)).toBeInTheDocument());
});

test("missing global token: save surfaces a hint instead of syncing", async () => {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/projects/p1/settings") return {};
    if (path === "/settings/github.token") return { value: "" };     // no credential
    if (path === "/projects/p1/settings/github.repo" && opts?.method === "PUT") return {};
    return {};
  });

  render(<TestWrapper><ProjectBindingsCard
    projectId="p1" id="github" title="GitHub" subtitle="Issues"
    borderColorClass="primary/30" icon={<div />}
    bindingKey="github.repo" label="Repo" globalCredentialKey="github.token" /></TestWrapper>);

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/projects/p1/settings"));
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "owner/newrepo" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(screen.getByText(/Set your GitHub token/)).toBeInTheDocument());
  expect(apiFetch).not.toHaveBeenCalledWith("/sync/p1", expect.anything());
});
