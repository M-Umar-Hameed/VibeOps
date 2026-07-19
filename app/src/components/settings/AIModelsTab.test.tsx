import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { AIModelsTab } from "./AIModelsTab.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

beforeEach(() => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/settings/ai.routing_strategy" && !opts) return Promise.resolve({ value: "cost" });
    if (path === "/settings/ai.routing_strategy" && opts?.method === "PATCH") return Promise.resolve({ value: opts.body.value });
    if (path === "/settings/agents.commProfile" && !opts) return Promise.resolve({ value: "off" });
    if (path === "/settings/agents.commProfile" && opts?.method === "PATCH") return Promise.resolve({ value: opts.body.value });
    return Promise.resolve({ value: "" });
  });
});

test("selecting Maximum Intelligence persists the routing strategy via PATCH", async () => {
  render(wrap(<AIModelsTab />));
  await waitFor(() => expect(screen.getByText("Maximum Intelligence")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Maximum Intelligence"));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith("/settings/ai.routing_strategy", { method: "PATCH", body: { value: "max" } }),
  );
});

test("switching the comm profile to Off persists via PATCH", async () => {
  render(wrap(<AIModelsTab />));
  await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
  // Multiple selects exist now (voyage model + comm profile); pick the comm one.
  const commSelect = screen.getAllByRole("combobox").find((el) => el.querySelector('option[value="auto"]'))!;
  fireEvent.change(commSelect, { target: { value: "off" } });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith("/settings/agents.commProfile", { method: "PATCH", body: { value: "off" } }),
  );
});
