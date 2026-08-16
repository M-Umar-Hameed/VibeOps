import "@testing-library/jest-dom";
import { vi } from "vitest";

vi.mock("react-virtuoso", () => import("./test/virtuoso-mock.js"));
