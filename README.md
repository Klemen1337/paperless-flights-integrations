# Flights Overhead · paperlesspaper Open Integration

Shows the aircraft around a location on a map, with small plane icons pointing
along their track, a short red trail behind each one, and a numbered list of
the closest flights (callsign, route, aircraft, altitude, speed, distance and
direction from you). Built for the L display in portrait first; layouts for L
landscape and the 7" display in both orientations come from the same page.

| L portrait (1200x1600) | 7" portrait (480x800) |
| --- | --- |
| ![](screenshots/flights-overhead-default-1200x1600-portrait.png) | ![](screenshots/flights-overhead-default-480x800-portrait.png) |

L landscape and 7" landscape put the map on the left and the list on the right.
Screenshots of every size, in the default and dark themes, are in `screenshots/`
(demo data, run through the Spectra 6 optimiser).

## Settings (chosen when adding the integration)

| Setting | Default | Notes |
| --- | --- | --- |
| Latitude / Longitude | 46.0569 / 14.5058 (Ljubljana) | Centre of the map, marked with a blue ring. |
| Map zoom | 9 | Web-map zoom levels 5 to 13 in half steps. 9 is about 60 km across the short side, 11 about 15 km. The same zoom shows the same area on the 7" and L panels. |
| Flights listed | 5 | Closest first. Rows that do not fit the layout are dropped (the map still shows every aircraft); 0 hides the list. |
| Trail length | 3 min | 0 hides trails. |
| Units | metric | aviation = ft/FL, kt, nm; metric = m, km/h, km; imperial = ft, mph, mi. |
| Show routes | on | Origin and destination when adsb.lol knows the callsign. |
| Include aircraft on the ground | off | |
| Hide aircraft below (ft) | 0 | Handy to drop low local traffic. |
| Map detail | detailed | detailed = roads, towns, built-up areas, water, borders; simple = no roads or built-up areas; none = rings and planes only. |
| Distance rings | on | |
| Title, location label, time zone | | Location label replaces the coordinates in the header. |
| Demo flights | off | Clearly labelled sample data for previews. |

The global colour theme from the paperlesspaper app is honoured (default `blue-light`).

## Data sources

- **Positions: [adsb.lol](https://adsb.lol)** `GET /v2/point/{lat}/{lon}/{radius_nm}`. Free,
  no API key, filters by GPS position and radius (up to 250 nm), community-fed and
  published under ODbL. Chosen over OpenSky (bounding box only, tighter
  anonymous limits) and airplanes.live (non-commercial terms, 1 request per
  second). airplanes.live, which has the same response format, is used as an
  automatic fallback when adsb.lol does not answer.
- **Trails:** the point endpoint has no history, and an e-ink frame refreshes far
  too rarely to build trails from its own snapshots. The data route therefore reads
  each visible aircraft's recent track from adsb.lol
  (`/data/traces/{xx}/trace_recent_{hex}.json`) and keeps the last N minutes.
  Positions this server has already seen are kept in memory as a fallback.
- **Routes:** adsb.lol `POST /api/0/routeset` (callsign to origin and destination).
- **Map:** built in, no tile server. Coastline, lakes, rivers, borders, roads and
  built-up areas from [Natural Earth](https://www.naturalearthdata.com) 1:10m
  (public domain), town names from [GeoNames](https://www.geonames.org) via
  `all-the-cities` (CC BY 4.0), airports from Natural Earth. Stored as 2x2 degree
  cells in `data/basemap/` (about 37 MB, worldwide) and drawn as SVG using only the
  six Spectra 6 colours, so lines stay crisp after the optimiser.

Upstream answers are cached for 20 s (positions), 45 s (traces) and 10 min
(routes) per server process, so several frames at one location share requests.

## Files

```txt
config.json          manifest (settings, languages, preview variants)
render.html          render page and layout CSS (portrait and landscape)
assets/render.js     map drawing, list and fitting
assets/geo.js        Web Mercator and distance math shared with the API
assets/paperless.*   toolkit runtime from @paperlesspaper/openintegration 0.1.3
assets/fonts/        Open Sans latin and latin-ext (for č, š, ž …)
api/data.js          data route: flights, trails, routes, basemap for the view
data/basemap/        prebuilt offline basemap cells
languages/           en, de, sl
server.mjs           dependency-free host (static files + /api/data + CORS)
scripts/             basemap builder, screenshot renderer, asset copier, icon source
tests/               node:test checks for the math and the data route
```

## Run and install

```sh
npm install
npm start                 # http://localhost:4400/ , manifest at /config.json
npm test
npm run check             # manifest validation
npm run dev               # paperlesspaper host simulator with live settings
CHROME_BIN=/path/to/chrome npm run render -- --epd   # refresh screenshots/
```

### Docker

```sh
docker compose up -d --build   # builds flights-overhead:latest, serves port 4400
docker compose logs -f
docker compose down
```

The image is Node 24 alpine, runs as the `node` user, has a `/health` check and
no npm dependencies. Change the left side of `ports` in `docker-compose.yml` to
use another host port.

To use it on a frame, the paperlesspaper app must reach the container over public
HTTPS, so put it behind a reverse proxy with a certificate (Caddy, Traefik, nginx)
or a tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok). Then add
`https://<host>/config.json` in the paperlesspaper app as an Open Integration.
`npm install` is only needed for development.

[DOCKER.md](DOCKER.md) walks through pushing the image to Docker Hub and running
it on your own server behind HTTPS.

To add it to the paperlesspaper `integrations` repository instead, copy the folder
to `applications/flights-overhead/`. That server does not serve `.css` or `.woff2`
from an app's own `assets/`, so point the stylesheet in `render.html` at the shared
`/assets/paperless.css` and drop the local latin-ext `@font-face` rules (or extend
the repo's allowed asset types).

## Rebuilding the basemap

```sh
mkdir .natural-earth && cd .natural-earth
for l in ne_10m_land ne_10m_lakes ne_10m_lakes_europe ne_10m_rivers_lake_centerlines \
         ne_10m_rivers_europe ne_10m_admin_0_boundary_lines_land ne_10m_urban_areas \
         ne_10m_roads ne_10m_airports; do
  curl -sLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/$l.geojson
done
cd .. && npm run build:basemap
```

## Known limits

- Live adsb.lol calls were checked against real responses for the field names, but
  the full live path (positions, traces, routes together) has not been exercised
  from a real host yet; the tests cover it with recorded-shape responses.
- Trails only appear for aircraft with an ICAO hex (not TIS-B `~` targets).
- Coverage depends on community feeders; remote areas may show few aircraft.
