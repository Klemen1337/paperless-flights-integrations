// Copies the shared paperlesspaper toolkit files and Open Sans fonts into
// assets/, so the integration folder is self-contained and can be hosted as
// plain static files plus the api/ route.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const toolkit = path.join(root, "node_modules/@paperlesspaper/openintegration/dist");
const openSans = path.join(root, "node_modules/@fontsource/open-sans/files");
const assets = path.join(root, "assets");
const fonts = path.join(assets, "fonts");

// Set KEEP_TOOLKIT=1 to keep the checked-in toolkit files (they may be newer
// than the npm release).
if (!process.env.KEEP_TOOLKIT) {
  for (const name of ["paperless.css", "paperless.js"]) {
    await copyFile(path.join(toolkit, name), path.join(assets, name));
  }
}

await mkdir(fonts, { recursive: true });
for (const subset of ["latin", "latin-ext"]) {
  for (const weight of [300, 400, 500, 600, 700, 800]) {
    for (const style of ["normal", "italic"]) {
      const file = `open-sans-${subset}-${weight}-${style}.woff2`;
      await copyFile(path.join(openSans, file), path.join(fonts, file));
    }
  }
}
console.log("toolkit assets and fonts copied to assets/");
