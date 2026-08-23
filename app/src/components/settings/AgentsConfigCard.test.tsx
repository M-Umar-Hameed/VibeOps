import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { AgentsConfigCard } from "./AgentsConfigCard.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

beforeEach(() => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "fake", roles: ["plan", "work", "review"], models: [{ name: "smart", tier: "expensive", quality: 5 }] }]);
    }
    if (path.startsWith("/settings/forge.defaultModel.") && opts?.method === "PATCH") {
      return Promise.resolve({ value: opts.body.value });
    }
    if (path === "/settings/forge.defaultModel.work" && !opts) return Promise.resolve({ value: "fake:smart" });
    return Promise.resolve({ value: "" });
  });
});

test("renders a default-model select per role with Auto and agent:model options", async () => {
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByLabelText("Default model for plan"));
  for (const role of ["plan", "work", "review"]) {
    expect(screen.getByLabelText(`Default model for ${role}`)).toBeInTheDocument();
  }
  await waitFor(() => expect(document.querySelector('option[value="fake:smart"]')).not.toBeNull());
  const work = screen.getByLabelText("Default model for work") as HTMLSelectElement;
  await waitFor(() => expect(work.value).toBe("fake:smart"));
});

test("changing a role default persists via PATCH", async () => {
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByLabelText("Default model for plan"));
  await waitFor(() => expect(document.querySelector('option[value="fake:smart"]')).not.toBeNull());
  fireEvent.change(screen.getByLabelText("Default model for plan"), { target: { value: "fake:smart" } });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith("/settings/forge.defaultModel.plan", { method: "PATCH", body: { value: "fake:smart" } }),
  );
});

test("a chat-only (http) agent renders no role checkboxes and the chat-only note", async () => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "openrouter", type: "http", roles: [], models: [] }]);
    }
    if (path === "/relay/agents/openrouter/catalog" && !opts) {
      return Promise.resolve({ models: [] });
    }
    return Promise.resolve({ value: "" });
  });
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByText("openrouter"));
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.getByText(
    "Chat-only lane: models here become the openrouter choices in chat. Leave empty to offer the whole catalog.",
  )).toBeInTheDocument();
});

test("saving a chat-only agent PATCHes roles: [] and its models", async () => {
  const patchCalls: any[] = [];
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "openrouter", type: "http", roles: [], models: [] }]);
    }
    if (path === "/relay/agents/openrouter/catalog" && !opts) {
      return Promise.resolve({ models: ["a/b"] });
    }
    if (path === "/relay/agents/openrouter" && opts?.method === "PATCH") {
      patchCalls.push(opts.body);
      return Promise.resolve({ name: "openrouter", roles: opts.body.roles, models: opts.body.models });
    }
    return Promise.resolve({ value: "" });
  });
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByText("openrouter"));
  fireEvent.click(screen.getByText("Add model"));
  const nameInput = screen.getByPlaceholderText("Type to search the catalog, or enter any model id");
  fireEvent.change(nameInput, { target: { value: "anthropic/claude-3.5-sonnet" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(patchCalls).toHaveLength(1));
  expect(patchCalls[0]).toEqual({
    roles: [],
    models: [{ name: "anthropic/claude-3.5-sonnet", tier: "cheap", quality: 3 }],
  });
});

test("a chat-only agent's model input offers catalog ids via a datalist", async () => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "openrouter", type: "http", roles: [], models: [] }]);
    }
    if (path === "/relay/agents/openrouter/catalog" && !opts) {
      return Promise.resolve({ models: ["a/b", "c/d"] });
    }
    return Promise.resolve({ value: "" });
  });
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByText("openrouter"));
  await waitFor(() =>
    expect(document.querySelector("datalist#catalog-openrouter option[value='a/b']")).not.toBeNull(),
  );
  expect(document.querySelector("datalist#catalog-openrouter option[value='c/d']")).not.toBeNull();
});

test("a cli agent still renders roles and Save stays disabled until one is picked", async () => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "fake", roles: [], models: [] }]);
    }
    return Promise.resolve({ value: "" });
  });
  render(wrap(<AgentsConfigCard />));
  await waitFor(() => screen.getByText("fake"));
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(3);
  expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(checkboxes[0]);
  await waitFor(() => expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false));
});
