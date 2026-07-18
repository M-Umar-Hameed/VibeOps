import { expect, test } from "vitest";
import { dialogAvailable, pickFolder } from "./native-dialog.js";

test("degrades gracefully when plugin is absent", async () => {
  expect(await dialogAvailable()).toBe(false);
  expect(await pickFolder()).toBe(null);
});
