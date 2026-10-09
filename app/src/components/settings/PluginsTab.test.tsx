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
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
  });
  expect(screen.getByText("beta")).toBeInTheDocument();
  expect(screen.getByText("https://github.com/o/r")).toBeInTheDocument();
});

test("Add marketplace posts the url and renders returned skills", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
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
  
  expect(apiFetch).toHaveBeenCalledWith("/skills/marketplaces", { method: "POST", body: { url: "https://github.com/new/repo" } });
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
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
  });
  
  expect(apiFetch).toHaveBeenCalledWith("/skills/install", { method: "POST", body: { url: "https://github.com/o/r", dir: "beta" } });
  expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
});

test("failed add shows the error message inline", async () => {
  render(<PluginsTab />);
  await waitFor(() => {
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
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

  expect(apiFetch).toHaveBeenCalledWith("/skills/marketplaces", { method: "POST", body: { url: "https://github.com/bad/repo" } });
  expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
});

test("registry search posts the query and renders ranked results", async () => {
  render(<PluginsTab />);
  await waitFor(() => { expect(screen.getAllByText("alpha").length).toBeGreaterThan(0); });

  const input = screen.getByPlaceholderText("Search skills (e.g. testing, deploy, react)");
  fireEvent.change(input, { target: { value: "testing" } });

  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/skills/registry/search")) {
      return Promise.resolve({ skills: [
        { name: "webapp-testing", source: "anthropics/skills", url: "https://github.com/anthropics/skills", installs: 172108, installed: false },
      ] });
    }
    if (path === "/skills/installed") return Promise.resolve(installedFixture);
    if (path === "/skills/marketplaces") return Promise.resolve(marketplacesFixture);
    return Promise.resolve({ ok: true });
  });

  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  await waitFor(() => { expect(screen.getByText("webapp-testing")).toBeInTheDocument(); });
  expect(screen.getByText(/anthropics\/skills/)).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith("/skills/registry/search?q=testing&limit=25");
});

test("installing a registry result posts source and name", async () => {
  // Installed-only marketplace BEFORE render, so the initial mount renders no
  // marketplace Install button and the registry result's is the only one.
  marketplacesFixture = [{ url: "https://github.com/o/r", skills: [{ name: "alpha", description: "alpha desc", dir: "alpha", installed: true }] }];
  render(<PluginsTab />);
  await waitFor(() => { expect(screen.getAllByText("alpha").length).toBeGreaterThan(0); });

  fireEvent.change(screen.getByPlaceholderText("Search skills (e.g. testing, deploy, react)"), { target: { value: "testing" } });
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: any }) => {
    if (path.startsWith("/skills/registry/search")) {
      return Promise.resolve({ skills: [
        { name: "webapp-testing", source: "anthropics/skills", url: "https://github.com/anthropics/skills", installs: 172108, installed: false },
      ] });
    }
    if (path === "/skills/registry/install" && init?.method === "POST") {
      return Promise.resolve({ name: "webapp-testing", dir: "webapp-testing", url: "https://github.com/anthropics/skills", installedAt: "2026-10-09T00:00:00Z" });
    }
    if (path === "/skills/installed") return Promise.resolve(installedFixture);
    // Only installed marketplace skills here, so the only "Install" button on the
    // page is the registry result's - keeps getByRole unambiguous.
    if (path === "/skills/marketplaces") return Promise.resolve([{ url: "https://github.com/o/r", skills: [{ name: "alpha", description: "alpha desc", dir: "alpha", installed: true }] }]);
    return Promise.resolve({ ok: true });
  });

  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => { expect(screen.getByText("webapp-testing")).toBeInTheDocument(); });

  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/skills/registry/install", { method: "POST", body: { source: "anthropics/skills", name: "webapp-testing" } });
  });
});
