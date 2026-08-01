import { clearSetting, withSetting } from "./tests/helpers/settings.js";
import { getSetting, setSetting } from "./src/services/settings.js";

async function test() {
  await setSetting("test_key", "test_val");
  console.log("after set:", await getSetting("test_key"));
  await clearSetting("test_key");
  console.log("after clear:", await getSetting("test_key"));
  process.exit(0);
}

test();
