import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsScreen } from "./settings.js";

const nav = vi.fn();
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => []) } }));
vi.mock("../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "", apiKey: "" })), saveSettings: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

test("Test connection shows Connected on success", async () => {
  render(<SettingsScreen />);
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
});
