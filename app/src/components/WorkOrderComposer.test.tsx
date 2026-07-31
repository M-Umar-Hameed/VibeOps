import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkOrderComposer, modelOptionsForRole, splitPair } from "./WorkOrderComposer.js";

const createTicket = vi.fn(async (_draft: any) => ({ id: "t1" }));
const launchPipeline = vi.fn(async (_t: any, _effort: any, _work?: any) => ({}));
const onCreated = vi.fn();

beforeEach(() => { createTicket.mockClear(); launchPipeline.mockClear(); onCreated.mockClear(); });

const OPTS = [{ value: "fake:smart", label: "fake / smart" }];

test("modelOptionsForRole builds agent:model pairs for the given role", () => {
  const agents = [
    { name: "fake", roles: ["work", "plan"], models: [{ name: "smart" }, { name: "fast" }] },
    { name: "planner", roles: ["plan"], models: [{ name: "x" }] },
  ];
  expect(modelOptionsForRole(agents, "work")).toEqual([
    { value: "fake:smart", label: "fake / smart" },
    { value: "fake:fast", label: "fake / fast" },
  ]);
});

test("splitPair splits on the first colon", () => {
  expect(splitPair("fake:smart")).toEqual({ agent: "fake", model: "smart" });
  expect(splitPair("fake")).toEqual({ agent: "fake", model: undefined });
});

test("RUN IT sends the chosen work model as a parsed pair", async () => {
  render(
    <WorkOrderComposer
      createTicket={createTicket}
      launchPipeline={launchPipeline}
      onCreated={onCreated}
      modelOptions={OPTS}
      defaultModel=""
    />,
  );
  fireEvent.change(screen.getByPlaceholderText(/Describe the work/i), { target: { value: "Do it" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "fake:smart" } });
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));
  await waitFor(() => expect(launchPipeline).toHaveBeenCalled());
  expect(launchPipeline.mock.calls[0][2]).toEqual({ agent: "fake", model: "smart" });
});

test("defaultModel preselects the control", async () => {
  render(
    <WorkOrderComposer
      createTicket={createTicket}
      launchPipeline={launchPipeline}
      onCreated={onCreated}
      modelOptions={OPTS}
      defaultModel="fake:smart"
    />,
  );
  await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("fake:smart"));
});
