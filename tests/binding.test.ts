import { expect, test } from "vitest";
import { normalizeBinding } from "../src/sync/binding.js";

test("strips github url to owner/repo", () => {
  expect(normalizeBinding("https://github.com/Foo/bar")).toBe("Foo/bar");
  expect(normalizeBinding("https://github.com/Foo/bar.git")).toBe("Foo/bar");
  expect(normalizeBinding("https://github.com/Foo/bar/")).toBe("Foo/bar");
});
test("no-op on bare values", () => {
  expect(normalizeBinding("owner/repo")).toBe("owner/repo");
  expect(normalizeBinding("ENG")).toBe("ENG");
  expect(normalizeBinding("1234567890")).toBe("1234567890");
});
test("idempotent", () => {
  expect(normalizeBinding(normalizeBinding("https://github.com/A/b.git"))).toBe("A/b");
});
