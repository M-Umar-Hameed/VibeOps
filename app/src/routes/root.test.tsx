import { expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));
vi.mock("../api/tickets.js", () => ({ tickets: { search: vi.fn(async () => []) } }));
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => []) } }));

vi.mock("@tanstack/react-router", () => ({
  Link: (p: any) => <a>{p.children}</a>,
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => vi.fn(),
  Outlet: () => <div data-testid="outlet" />,
}));

import { Root } from "./root.js";
import { ProjectProvider } from "../context/project.js";

const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient()}>
    <ProjectProvider>{ui}</ProjectProvider>
  </QueryClientProvider>
);

test("hamburger opens and closes sidebar", () => {
  render(wrap(<Root />));

  const aside = document.querySelector("aside")!;
  expect(aside.className).toContain("-translate-x-full");

  fireEvent.click(screen.getByText("menu"));
  expect(aside.className).toContain("translate-x-0");
  expect(document.querySelector(".fixed.inset-0.bg-black\\/50")).toBeTruthy();

  fireEvent.click(document.querySelector(".fixed.inset-0.bg-black\\/50")!);
  expect(aside.className).toContain("-translate-x-full");
  expect(document.querySelector(".fixed.inset-0.bg-black\\/50")).toBeFalsy();
});
