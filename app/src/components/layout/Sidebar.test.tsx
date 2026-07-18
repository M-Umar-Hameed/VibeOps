import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../lib/api.js", () => ({ 
  api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})), patch: vi.fn(async () => ({})) } 
}));

vi.mock("../../api/projects.js", () => ({ 
  projects: { list: vi.fn(async () => []), create: vi.fn() } 
}));

vi.mock("../../lib/native-dialog.js", () => ({ 
  dialogAvailable: vi.fn(async () => false), pickFolder: vi.fn() 
}));

vi.mock("../../context/project.js", () => ({
  useProject: () => ({ projects: [], activeProjectId: null, setActiveProject: vi.fn(), refreshProjects: vi.fn() }),
  ProjectProvider: (p: any) => <div>{p.children}</div>
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (p: any) => <a data-testid="link">{p.children}</a>,
  useLocation: () => ({ pathname: "/" }),
}));

import { Sidebar } from "./Sidebar.js";

test("primary nav renders 4 links and Library section toggles", () => {
  render(<Sidebar isOpen={true} />);

  const navs = document.querySelectorAll("nav");
  expect(navs.length).toBe(1); 

  const primaryNav = navs[0];
  const primaryLinks = primaryNav.querySelectorAll("a");
  expect(primaryLinks.length).toBe(4);
  
  expect(within(primaryNav).getByText("Board")).toBeInTheDocument();
  expect(within(primaryNav).getByText("Forge")).toBeInTheDocument();
  expect(within(primaryNav).getByText("Usage")).toBeInTheDocument();
  expect(within(primaryNav).getByText("Settings")).toBeInTheDocument();

  expect(screen.queryByText("Knowledge")).not.toBeInTheDocument();
  expect(screen.queryByText("New Work Order")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("Library"));

  const navsAfter = document.querySelectorAll("nav");
  expect(navsAfter.length).toBe(2);
  
  const libraryNav = navsAfter[1];
  expect(within(libraryNav).getByText("Knowledge")).toBeInTheDocument();
  expect(within(libraryNav).getByText("New Work Order")).toBeInTheDocument();
});
