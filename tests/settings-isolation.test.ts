import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { getSetting, setSetting, deleteSetting } from "../src/services/settings.js";
import { withSetting } from "./helpers/settings.js";

const uniq = (p: string) => `${p}.${process.pid}.${Math.random().toString(36).slice(2)}`;

describe("settings override isolation", () => {
  it("withSetting is observable via getSetting inside its scope and gone after", async () => {
    const key = uniq("test.override");
    expect(await getSetting(key)).toBeNull();
    await withSetting(key, "on", async () => {
      expect(await getSetting(key)).toBe("on");
    });
    expect(await getSetting(key)).toBeNull();
  });

  it("withSetting override never writes the shared settings table", async () => {
    const key = uniq("test.override.nodb");
    await withSetting(key, "on", async () => {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
      expect(row).toBeUndefined();
    });
  });

  it("setSetting/deleteSetting still persist to the database outside overrides", async () => {
    const key = uniq("test.persist");
    await setSetting(key, "v1");
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    expect(row?.value).toBe("v1");
    expect(await getSetting(key)).toBe("v1");
    await deleteSetting(key);
    const [gone] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    expect(gone).toBeUndefined();
  });
});
