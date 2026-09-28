# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Flights Overhead", a paperlesspaper Open Integration: a single web page rendered by the paperlesspaper host onto
e-ink frames (Spectra 6 panels), showing aircraft around a location on a map plus a list of the closest flights.
Target sizes: L panel 1200x1600 / 1600x1200 and 7" panel 480x800 / 800x480; portrait is the primary layout.

## Commands

```sh
npm start                     # node server.mjs, http://localhost:4400/ (PORT env overrides)
node --test tests/            # run tests (see note below)
node --test --test-name-pattern="demo mode" tests/   # single test by name
npm run check                 # validate config.json manifest with the paperlesspaper toolkit
npm run dev                   # paperlesspaper host simulator with live settings
CHROME_BIN=/path/to/chrome npm run render -- --epd   # regenerate screenshots/ (+ Spectra 6 optimised) and record them in config.json
npm run build:basemap         # rebuild data/basemap/ from Natural Earth GeoJSON in .natural-earth/ (see README)
npm run copy:assets           # copy toolkit runtime + Open Sans fonts from node_modules into assets/ (KEEP_TOOLKIT=1 keeps assets/paperless.*)
docker compose up -d --build  # container on port 4400
```

- `npm test` uses the glob `tests/*.test.mjs`, which is not expanded on Windows; use `node --test tests/` there.
- A running `flights-overhead` Docker container may already hold the port and serve an older build. `.claude/launch.json`
  has `autoPort: true` so the preview then runs the local source on another port. Rebuild the container to see changes there.
- No runtime npm dependencies: `server.mjs` and `api/data.js` use only Node built-ins. devDependencies are only for the
  toolkit CLI, fonts and the basemap builder.

## Architecture

**Request flow.** The host loads `render.html` (via `/config.json` manifest), which runs `assets/render.js`. That script
waits for the host payload (`waitForPayload` from `assets/paperless.js`, the vendored toolkit runtime), merges settings,
measures the map area, and GETs same-origin `./api/data?…` with the map's pixel size. `api/data.js` (default export
`handler({ query })`) projects the view, fetches positions/trails/routes/photos upstream, loads basemap cells, and returns
one JSON payload. `server.mjs` is a minimal host: static files restricted to a `PUBLIC` allow-list, `/api/data`, `/health`, CORS.
The same `api/data.js` handler shape is what the paperlesspaper `integrations` repo expects, so keep it host-agnostic.

**Shared geometry.** `assets/geo.js` (Web Mercator projection, distance/bearing, basemap cell keys) is imported by both the
browser and the API, so the server's bbox and the client's drawing match exactly. Zoom is defined so the same zoom shows
the same area on 7" and L panels.

**Render sequence in `renderPayload`** (render.js): draw header → fetch data → build list → wait for photos to decode →
drop list rows from the end until nothing overflows → if the map grew noticeably, refetch for the new size → draw the SVG
map → `markReady()`. Only the newest render may touch the DOM (`renderSeq`/`stale()`); re-render happens only when
settings or language change, never on a timer (the frame reloads the page on its own schedule).

**Upstream data** (all free, no key), cached in-process: positions from adsb.lol `/v2/point` (fallback airplanes.live,
same format), trails from adsb.lol `trace_recent_{hex}.json` plus an in-memory history fallback, routes from adsb.lol
`routeset` (fallback adsb.im), photos from planespotters.net. `sampleData=true` returns clearly labelled demo flights and
is what the manifest's preview variants/screenshots use.

**Basemap.** Offline, no tile server: `data/basemap/` holds 2x2° cells built from Natural Earth + GeoNames and is drawn
as SVG in render.js using only panel inks.

## Conventions that span files

- **Adding/changing a setting** touches: `config.json` (`formSchema` property + default, and both `configVariants`),
  `defaults` in `assets/render.js`, its type/limits in `SETTINGS` in `assets/settings.js`, the query params in
  `fetchData()` if the API needs it, parsing in `api/data.js` `handler`, and the settings table in `README.md`.
- **Settings arrive as arbitrary strings.** Parse them only through `assets/settings.js` (shared by page and API):
  strict decimals (comma allowed, `""` is *missing*, never `0`), booleans like `true/yes/on`, trimmed case-insensitive
  choices. Missing → default silently; present but unusable → default and listed in the red "Check settings" notice.
  Coordinates out of range are rejected, not clamped.
- **User-visible strings** go in `languages/en.json`, `de.json`, `sl.json` (read as `messages.*` with an English fallback
  in code; `fill()` substitutes `{placeholders}`).
- **Colours**: the panel has only a few inks and the optimiser snaps everything else to the nearest one. Use the `--pp-*`
  theme variables; the per-flight look (badge/plane/trail) comes from `INKS` × `STYLES` in `flightColor()`, not new colours.
  The global theme from the app (`settings.color`, default `blue-light`) must keep working, including `dark`.
- **Sizing**: everything scales with the design unit `--u` (`render.html`, mirrored as `u` in render.js). Font sizes use
  the four-step scale `--fs-1`…`--fs-4`; the two-column list overrides those variables rather than setting sizes per rule.
  Map label sizes in render.js follow the same steps.
- **Layout**: portrait = header / map / list (stacked, list in two columns); landscape = map left, header + list right.
  Both come from media queries in `render.html`; check both orientations after layout changes.
- Open Sans (vendored in `assets/fonts/`, incl. latin-ext for č/š/ž) has no arrow glyphs, so arrows are inline SVG.
- When copying into the paperlesspaper `integrations` repo (`applications/flights-overhead/`), that server doesn't serve
  `.css`/`.woff2` from an app's `assets/`; point the stylesheet at the shared `/assets/paperless.css` and drop the
  local latin-ext `@font-face` rules.
