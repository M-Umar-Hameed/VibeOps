import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { PluginsTab } from "./PluginsTab.js";

let installedFixture: any[] = [];
let marketplacesFixture: any[] = [];

beforeEach(() => {
  installedFixture = [
    { name: "alpha", dir: "alpha", url: "https://github.com/o/r", installedAt: "2026-07-01T00:00:00Z", present: true }
  ];
  marketplacesFixture = [
    { 
      url: "https://github.com/o/r", 
      skills: [
        { name: "alpha", description: "alpha desc", dir: "alpha", installed: true }, 
        { name: "beta", description: "beta desc", dir: "beta", installed: false }
      ] 
    }
  ];

  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/skills/installed" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(installedFixture);
    }
    if (path === "/skills/marketplaces" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(marketplacesFixture);
    }
    return Promise.resolve({ ok: true });
  });
});

test("renders installed skills and marketplace skill lists", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });
  expect(screen.getByText("beta")).toBeInTheDocument();
  expect(screen.getByText("https://github.com/o/r")).toBeInTheDocument();
});

test("Add marketplace posts the url and renders returned skills", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("https://github.com/owner/repo");
  const addButton = screen.getByRole("button", { name: "Add" });

  fireEvent.change(input, { target: { value: "https://github.com/new/repo" } });
  
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: any }) => {
    if (path === "/skills/marketplaces" && init?.method === "POST" && init.body?.url === "https://github.com/new/repo") {
      marketplacesFixture = [...marketplacesFixture, {
        url: "https://github.com/new/repo",
        skills: [{ name: "gamma", description: "gamma desc", dir: "gamma", installed: false }]
      }];
      return Promise.resolve(marketplacesFixture[1]);
    }
    if (path === "/skills/installed" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(installedFixture);
    }
    if (path === "/skills/marketplaces" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(marketplacesFixture);
    }
    return Promise.resolve({ ok: true });
  });

  fireEvent.click(addButton);

  await waitFor(() => {
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });
  expect(input).toHaveValue("");
});

test("Install posts { url, dir } and flips the row to Installed after refresh", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  const installButton = screen.getByRole("button", { name: "Install" });
  
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: any }) => {
    if (path === "/skills/install" && init?.method === "POST" && init.body?.dir === "beta") {
      marketplacesFixture[0].skills[1].installed = true;
      installedFixture.push({ name: "beta", dir: "beta", url: "https://github.com/o/r", installedAt: "2026-07-02T00:00:00Z", present: true });
      return Promise.resolve({ ok: true });
    }
    if (path === "/skills/installed" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(installedFixture);
    }
    if (path === "/skills/marketplaces" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(marketplacesFixture);
    }
    return Promise.resolve({ ok: true });
  });

  fireEvent.click(installButton);

  await waitFor(() => {
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
  });
  
  const uninstallButtons = screen.getAllByRole("button", { name: "Uninstall" });
  expect(uninstallButtons.length).toBeGreaterThan(1);
});

test("failed add shows the error message inline", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("https://github.com/owner/repo");
  const addButton = screen.getByRole("button", { name: "Add" });

  fireEvent.change(input, { target: { value: "https://github.com/bad/repo" } });

  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: any }) => {
    if (path === "/skills/marketplaces" && init?.method === "POST" && init.body?.url === "https://github.com/bad/repo") {
      return Promise.reject(new Error("not a github repo url"));
    }
    if (path === "/skills/installed" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(installedFixture);
    }
    if (path === "/skills/marketplaces" && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve(marketplacesFixture);
    }
    return Promise.resolve({ ok: true });
  });

  fireEvent.click(addButton);

  await waitFor(() => {
    expect(screen.getByText("not a github repo url")).toBeInTheDocument();
  });

  expect(screen.getByText("alpha")).toBeInTheDocument();
});
