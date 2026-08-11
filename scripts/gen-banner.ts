// scripts/gen-banner.ts — one-off: regenerate the README hero banner via Gemini
// image generation (gemini-2.5-flash-image, "Nano Banana").
// Run: npx tsx scripts/gen-banner.ts
// Reads GEMINI_API_KEY from the environment, falling back to the google.api_key
// setting (applyEnvSettings mirrors it into env). Never hardcodes or prints the key.
import { join } from "node:path";
import sharp from "sharp";
import { applyEnvSettings } from "../src/services/settings.js";

const PROMPT =
  'A clean, modern developer-tool hero banner for "VibeOps", a self-hosted agent ' +
  "operations console. Wide 16:5 aspect. Abstract supervised pipeline: a work-order " +
  "queue flowing left to right through discrete gates into a single merge point. " +
  "Cool slate-and-amber palette, subtle grid, flat vector style, generous negative " +
  "space. No text, no logos, no lettering, no user-interface screenshots.";

const MODEL = "gemini-2.5-flash-image";
const OUT = join("docs", "banner.webp");

async function main(): Promise<void> {
  await applyEnvSettings().catch(() => {}); // best-effort: mirror google.api_key -> env
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error(
      "GEMINI_API_KEY is not set and google.api_key is absent from settings. " +
      "Aborting; the README banner is left untouched.",
    );
    process.exit(1);
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }] }),
    },
  );
  if (!res.ok) {
    console.error(`Gemini request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  };
  const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) {
    console.error("Gemini response contained no image data.");
    process.exit(1);
  }
  const png = Buffer.from(b64, "base64");
  await sharp(png).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 80 }).toFile(OUT);
  console.log(`wrote ${OUT} — source ${png.length} bytes, resized to <=1280px webp`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
