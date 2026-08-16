import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../lib/api.js", () => ({ api: { get: vi.fn(async () => ({})) } }));
vi.mock("@tanstack/react-router", () => ({ Link: (p: any) => <a>{p.children}</a> }));

import { UsageScreen } from "./usage.js";

test("Usage renders as its own surface", () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UsageScreen />
    </QueryClientProvider>
  );
  expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
});
