import { expect, test, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { OutputPane } from "./OutputPane.js";
import { lastVirtuosoProps } from "../test/virtuoso-mock.js";

beforeEach(() => {
  lastVirtuosoProps.current = null;
});

test("renders appended chunks", () => {
  const { rerender } = render(<OutputPane chunks={["a", "b"]} />);
  expect(screen.getAllByTestId("virtuoso-row").map((n) => n.textContent)).toEqual(["a", "b"]);
  rerender(<OutputPane chunks={["a", "b", "c"]} />);
  expect(screen.getAllByTestId("virtuoso-row").map((n) => n.textContent)).toEqual(["a", "b", "c"]);
});

test("prior rows are not remounted across appends (stable keys)", () => {
  const { rerender } = render(<OutputPane chunks={["a", "b"]} />);
  const before = screen.getAllByTestId("virtuoso-row");
  const row0 = before[0], row1 = before[1];
  rerender(<OutputPane chunks={["a", "b", "c"]} />);
  const after = screen.getAllByTestId("virtuoso-row");
  expect(after[0]).toBe(row0); // same DOM node -> no remount
  expect(after[1]).toBe(row1);
});

test("followOutput wiring present so bottom-stick is conditional", () => {
  render(<OutputPane chunks={["x"]} />);
  expect(lastVirtuosoProps.current.followOutput).toBeDefined();
  expect(lastVirtuosoProps.current.computeItemKey(0)).toBe(0);
  expect(lastVirtuosoProps.current.computeItemKey(3)).toBe(3);
});
