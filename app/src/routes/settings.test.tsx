import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// LocalNodeTab now embeds BrowserGrantsCard, which uses react-query.
const withClient = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

vi.mock("../lib/api.js", () => ({ api: { get: vi.fn(async () => []), post: vi.fn(async () => ({})), del: vi.fn(async () => ({})) } }));
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => []) } }));
vi.mock("../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "", apiKey: "" })), saveSettings: vi.fn(async () => {}), detectLocalNode: vi.fn(async () => null) }));

// SettingsScreen is now tabbed; the connection UI lives in LocalNodeTab, which
// defaults to the "integrations" tab when rendered via SettingsScreen. Render
// LocalNodeTab directly to test the connection-test path.
import { LocalNodeTab } from "../components/settings/LocalNodeTab.js";
import { saveSettings } from "../settings.js";

test("Test Link shows CONNECTED on success", async () => {
  render(withClient(<LocalNodeTab rejected={false} />));
  fireEvent.click(screen.getByText("Test Link"));
  await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());
});

test("Save Config shows a pending then saved state", async () => {
  let resolve!: () => void;
  (saveSettings as any).mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  render(withClient(<LocalNodeTab rejected={false} />));
  fireEvent.click(screen.getByText("Save Config"));
  expect(await screen.findByText("Saving...")).toBeInTheDocument();
  resolve();
  await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
});

test("Test Link disables its button while probing", async () => {
  (saveSettings as any).mockImplementationOnce(() => new Promise<void>(() => {})); // test() awaits saveSettings first, so it stays in-flight
  render(withClient(<LocalNodeTab rejected={false} />));
  fireEvent.click(screen.getByText("Test Link"));
  await waitFor(() => expect(screen.getByText("Test Link").closest("button")).toBeDisabled());
});
