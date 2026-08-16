import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContextMenu, type MenuItemSpec } from "./ContextMenu.js";

test("shows a per-item spinner while a slow onSelect runs, then the notice", async () => {
  let resolve!: (v: string) => void;
  const items: MenuItemSpec[] = [
    { key: "slow", label: "Index docs", onSelect: () => new Promise<string>((r) => { resolve = r; }) },
  ];
  render(<ContextMenu items={items} x={0} y={0} label="Actions" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("menuitem", { name: /Index docs/ }));
  expect(await screen.findByTestId("menu-item-spinner")).toBeInTheDocument();
  resolve("indexed 3, skipped 0, removed 0");
  await waitFor(() => expect(screen.queryByTestId("menu-item-spinner")).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("indexed 3");
});
