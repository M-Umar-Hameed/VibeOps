import { createActor } from "../services/actors.js";

async function main() {
  console.log("Generating local root key...");
  try {
    const { apiKey } = await createActor({
      name: "local-admin",
      kind: "human",
      role: "admin",
    });
    console.log("\n=====================================");
    console.log("🗝️  YOUR NEW API KEY");
    console.log("=====================================");
    console.log(apiKey);
    console.log("=====================================\n");
    console.log("Copy and paste this key into the VibeOps Local Node settings.");
  } catch (err) {
    console.error("Failed to generate key:", err);
  }
  process.exit(0);
}

main();
