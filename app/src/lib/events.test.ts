import React from "react";
import { expect, test, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";

vi.mock("../settings.js", () => ({ getSettings: async () => ({ baseUrl: "http://x", apiKey: "K K" }) }));

import {
  startEventStream, stopEventStream, setEventSourceImpl,
  useStreamConnected,
} from "./events.js";

class FakeES {
  static last: FakeES | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, (() => void)[]> = {};
  constructor(url: string) { this.url = url; FakeES.last = this; }
  addEventListener(t: string, cb: () => void) { (this.listeners[t] ||= []).push(cb); }
  emit(t: string) { (this.listeners[t] || []).forEach((f) => f()); }
  close() {}
}

afterEach(() => { stopEventStream(); FakeES.last = null; vi.restoreAllMocks(); });

test("opens one EventSource with the key as a query param", async () => {
  setEventSourceImpl(FakeES as any);
  await startEventStream(new QueryClient());
  expect(FakeES.last?.url).toBe("http://x/events?access_token=K%20K");
});

test("run.settled frame invalidates the forge runs and tickets keys", async () => {
  setEventSourceImpl(FakeES as any);
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  await startEventStream(qc);
  FakeES.last!.onopen?.();
  FakeES.last!.emit("run.settled");
  const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as any).queryKey));
  expect(keys).toContain(JSON.stringify(["forge", "runs"]));
  expect(keys).toContain(JSON.stringify(["forge", "tickets"]));
  expect(keys).toContain(JSON.stringify(["tickets"]));
});

test("onopen/onerror drive the connection flag", async () => {
  setEventSourceImpl(FakeES as any);
  await startEventStream(new QueryClient());
  function Probe() { return React.createElement("span", null, useStreamConnected() ? "on" : "off"); }
  render(React.createElement(Probe));
  expect(screen.getByText("off")).toBeInTheDocument();
  act(() => { FakeES.last!.onopen?.(); });
  expect(screen.getByText("on")).toBeInTheDocument();
  act(() => { FakeES.last!.onerror?.(); });
  expect(screen.getByText("off")).toBeInTheDocument();
});
