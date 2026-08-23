import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client.js", () => ({
  apiFetchBlob: vi.fn(async () => new Blob(["fake"], { type: "image/png" })),
}));

import { Markdown } from "./Markdown.js";

test("renders bold, heading, bullets, numbered list with no literal markers", () => {
  const { container } = render(
    <Markdown text={"### Heading\n**bold** text\n- item one\n- item two\n1. first\n2. second"} />
  );
  expect(container.textContent).not.toContain("**");
  expect(container.textContent).not.toContain("#");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelectorAll("ul li")).toHaveLength(2);
  expect(container.querySelectorAll("ol li")).toHaveLength(2);
});

test("inline code renders in code element, markers stripped", () => {
  const { container } = render(<Markdown text={"run `npm test` now"} />);
  expect(container.querySelector("code")?.textContent).toBe("npm test");
  expect(container.textContent).not.toContain("`");
});

test("raw HTML stays literal text, never parsed", () => {
  const { container } = render(<Markdown text={"<script>alert(1)</script> **x**"} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
});

test("unmatched leading ** bolds without literal asterisks", () => {
  const { container } = render(<Markdown text={"**Great idea"} />);
  expect(container.querySelector("strong")?.textContent).toBe("Great idea");
  expect(container.textContent).not.toContain("*");
});

test("an attachment image link renders via AttachmentImage", async () => {
  const path = "/home/user/.vibeops/attachments/11111111-1111-1111-1111-111111111111.png";
  render(<Markdown text={`![shot](${path})`} />);
  await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
});

test("a non-attachment image link renders as literal text", () => {
  const { container } = render(<Markdown text={"![pic](https://example.com/x.png)"} />);
  expect(container.textContent).toContain("![pic](https://example.com/x.png)");
  expect(container.querySelector("img")).toBeNull();
});
