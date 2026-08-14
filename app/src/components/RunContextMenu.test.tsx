import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RunContextMenu, type MenuItemSpec } from "./RunContextMenu.js";

test("renders each item label, disabled item is disabled and shows disabledReason", () => {
  const items: MenuItemSpec[] = [
    { key: "item1", label: "Enabled Item", onSelect: vi.fn() },
    { key: "item2", label: "Disabled Item", disabled: true, disabledReason: "Reason for disable", onSelect: vi.fn() },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={vi.fn()} />);

  expect(screen.getByText("Enabled Item")).toBeInTheDocument();
  const disabledBtn = screen.getByText("Disabled Item").closest("button");
  expect(disabledBtn).toBeDisabled();
  expect(screen.getByText("Reason for disable")).toBeInTheDocument();
});

test("Escape key calls onClose", () => {
  const onClose = vi.fn();
  const items: MenuItemSpec[] = [
    { key: "item1", label: "Item 1", onSelect: vi.fn() },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={onClose} />);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Backdrop click calls onClose", () => {
  const onClose = vi.fn();
  const items: MenuItemSpec[] = [
    { key: "item1", label: "Item 1", onSelect: vi.fn() },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={onClose} />);

  fireEvent.click(screen.getByTestId("run-menu-backdrop"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Confirm flow: click opens confirm dialog, Cancel aborts, Confirm executes onSelect", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const items: MenuItemSpec[] = [
    {
      key: "dangerous",
      label: "Dangerous Action",
      confirm: {
        title: "Are you sure?",
        message: "This will do something risky.",
        confirmLabel: "Proceed",
      },
      onSelect,
    },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={onClose} />);

  fireEvent.click(screen.getByText("Dangerous Action"));
  expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  expect(screen.getByText("This will do something risky.")).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();

  // Cancel
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  expect(screen.getByText("Dangerous Action")).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();

  // Open confirm again and confirm
  fireEvent.click(screen.getByText("Dangerous Action"));
  fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Non-confirm item calls onSelect once and closes menu", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const items: MenuItemSpec[] = [
    { key: "simple", label: "Simple Action", onSelect },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={onClose} />);

  fireEvent.click(screen.getByText("Simple Action"));
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Keyboard navigation: focus first enabled item, ArrowDown moves focus, click triggers onSelect", () => {
  const onSelect1 = vi.fn();
  const onSelect2 = vi.fn();
  const items: MenuItemSpec[] = [
    { key: "disabled0", label: "Disabled 0", disabled: true, onSelect: vi.fn() },
    { key: "item1", label: "Item 1", onSelect: onSelect1 },
    { key: "item2", label: "Item 2", onSelect: onSelect2 },
  ];

  render(<RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={vi.fn()} />);

  const item1Btn = screen.getByText("Item 1").closest("button");
  const item2Btn = screen.getByText("Item 2").closest("button");

  expect(document.activeElement).toBe(item1Btn);

  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(document.activeElement).toBe(item2Btn);

  fireEvent.click(document.activeElement as HTMLElement);
  expect(onSelect2).toHaveBeenCalledTimes(1);
});

test("Viewport clamp: clamps menu position inside screen bounds", () => {
  const items: MenuItemSpec[] = [
    { key: "item1", label: "Item 1", onSelect: vi.fn() },
  ];

  render(<RunContextMenu items={items} x={99999} y={99999} label="Test Menu" onClose={vi.fn()} />);

  const menu = screen.getByRole("menu");
  const left = parseInt(menu.style.left, 10);
  const top = parseInt(menu.style.top, 10);

  expect(left).toBeLessThanOrEqual(window.innerWidth - 260);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThanOrEqual(window.innerHeight - 220);
  expect(top).toBeGreaterThanOrEqual(0);
});

// A backdrop-filter ancestor (.glass-card) becomes the containing block for
// fixed-position descendants, so an in-tree menu resolves viewport coordinates
// against the card and lands off-page, scrolling the whole layout sideways.
test("menu escapes a backdrop-filter ancestor by portalling to body", () => {
  const items: MenuItemSpec[] = [{ key: "item1", label: "Item 1", onSelect: vi.fn() }];

  const { container } = render(
    <div className="glass-card" style={{ backdropFilter: "blur(20px)" }}>
      <RunContextMenu items={items} x={100} y={100} label="Test Menu" onClose={vi.fn()} />
    </div>,
  );

  const menu = screen.getByRole("menu", { name: "Test Menu" });
  expect(container.querySelector(".glass-card")?.contains(menu)).toBe(false);
  expect(document.body.contains(menu)).toBe(true);
});
