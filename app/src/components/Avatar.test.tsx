import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const list = vi.fn();
const identity = vi.fn();
vi.mock("../api/actors.js", () => ({ actors: { list: (...a: any[]) => list(...a) } }));
vi.mock("../api/git.js", () => ({ git: { identity: (...a: any[]) => identity(...a) } }));

import { Avatar } from "./Avatar.js";
import { fireEvent } from "@testing-library/react";

const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

beforeEach(() => {
  list.mockReset().mockResolvedValue([
    { id: "h1", name: "octocat", kind: "human", role: "admin" },
    { id: "a1", name: "Bot", kind: "agent", role: "member" },
  ]);
  identity.mockReset().mockResolvedValue({ name: "octocat" });
});

test("human actor renders github avatar", async () => {
  render(wrap(<Avatar actorId="h1" />));
  await waitFor(() => {
    const img = screen.getByAltText("octocat") as HTMLImageElement;
    expect(img.src).toBe("https://github.com/octocat.png");
  });
});

test("agent actor renders dicebear", async () => {
  render(wrap(<Avatar actorId="a1" />));
  await waitFor(() => {
    const img = screen.getByAltText("Bot") as HTMLImageElement;
    expect(img.src).toContain("api.dicebear.com");
  });
});

test("null identity keeps dicebear for human", async () => {
  identity.mockResolvedValue({ name: null });
  render(wrap(<Avatar actorId="h1" />));
  await waitFor(() => {
    const img = screen.getByAltText("octocat") as HTMLImageElement;
    expect(img.src).toContain("api.dicebear.com");
  });
});

test("github img error falls back to dicebear", async () => {
  render(wrap(<Avatar actorId="h1" />));
  const img = await screen.findByAltText("octocat") as HTMLImageElement;
  await waitFor(() => expect(img.src).toBe("https://github.com/octocat.png"));
  fireEvent.error(img);
  await waitFor(() => expect(img.src).toContain("api.dicebear.com"));
});
