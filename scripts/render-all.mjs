// Renders demo screenshots for every paperlesspaper display size and
// orientation into screenshots/ and records them in config.json.
//
//   CHROME_BIN=/path/to/chrome node scripts/render-all.mjs [--epd]
//
// --epd also writes the Spectra 6 optimised version next to each raw PNG.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";

const viewports = [
  { key: "1200x1600", orientation: "portrait", label: "L portrait" },
  { key: "1600x1200", orientation: "landscape", label: "L landscape" },
  { key: "480x800", orientation: "portrait", label: "7in portrait" },
  { key: "800x480", orientation: "landscape", label: "7in landscape" },
];
const variants = [
  { id: "default", settings: { sampleData: true, color: "blue-light" } },
  { id: "dark", settings: { sampleData: true, color: "dark" } },
];
const epd = process.argv.includes("--epd");
const config = JSON.parse(await fs.readFile("config.json", "utf8"));
config.configVariants = [];

for (const variant of variants) {
  const screenshots = {};
  for (const vp of viewports) {
    const out = `./screenshots/flights-overhead-${variant.id}-${vp.key}-${vp.orientation}.png`;
    const args = [
      "paperlesspaper-openintegration", "render", "./config.json",
      "--viewport", vp.key, "--orientation", vp.orientation, "--language", "en",
      "--color", variant.settings.color, "--settings", JSON.stringify(variant.settings),
      "--epd-output", "device", "--output", out,
    ];
    if (!epd) args.push("--raw");
    const r = spawnSync("npx", args, { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
    screenshots[vp.key] = out;
  }
  config.configVariants.push({ ...config.nativeSettings, ...variant.settings, screenshots });
}
await fs.writeFile("config.json", `${JSON.stringify(config, null, 2)}\n`);
