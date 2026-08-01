import { getSetting, setSetting } from "./src/services/settings.js";

async function test() {
  await setSetting("ai.routing_strategy", "cheapest-first");
  await setSetting("forge.defaultModel.plan", "fake:smart");
  
  let val = await getSetting("forge.defaultModel.plan");
  console.log("1", val);
  
  await setSetting("forge.defaultModel.plan", "");
  val = await getSetting("forge.defaultModel.plan");
  console.log("2", val);
  
  const strategy = await getSetting("ai.routing_strategy");
  console.log("strategy", strategy);
  
  process.exit(0);
}

test();
