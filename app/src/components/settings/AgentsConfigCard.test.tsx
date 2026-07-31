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
