// Data route for the Flights Overhead integration.
//
// Called by render.html as a same-origin GET to ./api/data. Returns the
// aircraft inside the visible map, a short trail for each, optional route
// info, and the offline basemap features for the same area.
//
// Upstream sources (all free, no API key):
//   positions  https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}
//              fallback https://api.airplanes.live/v2/point/... (same format)
//   trails     https://adsb.lol/data/traces/{xx}/trace_recent_{hex}.json
//              plus an in-memory history of positions seen by this server
//   routes     https://api.adsb.lol/api/0/routeset (POST)
//              fallback https://adsb.im/api/0/routeset (the service behind it)
//   photos     https://api.planespotters.net/pub/photos/hex/{hex}
//              (thumbnails may be shown with the photographer credited)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CELL_DEG,
  KM_PER_NM,
  bearingDeg,
  cellKey,
  createProjection,
  destination,
  distanceKm,
} from "../assets/geo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const basemapDir = path.resolve(here, "..", "data", "basemap");
const USER_AGENT = "paperlesspaper-flights-overhead/0.1 (+https://paperlesspaper.de)";

const POINT_SOURCES = [
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
];
const TRACE_URL = (hex) => `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_recent_${hex}.json`;
// adsb.lol's routeset has been seen answering 201 with an empty body, so fall
// back to adsb.im, which it proxies.
const ROUTESET_URLS = ["https://api.adsb.lol/api/0/routeset", "https://adsb.im/api/0/routeset"];

const PHOTO_URL = (hex) => `https://api.planespotters.net/pub/photos/hex/${hex}`;

const MAX_MAP_FLIGHTS = 40;
const MAX_TRACE_FETCHES = 20;

// ---------------------------------------------------------------- helpers

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

async function fetchJson(url, { timeoutMs = 6000, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Small TTL cache shared by every render served by this process.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
  }
  return value;
}

// Positions this server has already seen, kept for trails when the trace
// endpoint is unavailable. hex -> [{ t, lat, lon }]
const history = new Map();
const HISTORY_MS = 30 * 60 * 1000;
function remember(flight, now) {
  const list = history.get(flight.hex) || [];
  const last = list.at(-1);
  if (!last || last.lat !== flight.lat || last.lon !== flight.lon) list.push({ t: now, lat: flight.lat, lon: flight.lon });
  while (list.length && list[0].t < now - HISTORY_MS) list.shift();
  history.set(flight.hex, list);
  if (history.size > 5000) {
    for (const [hex, l] of history) if (!l.length || l.at(-1).t < now - HISTORY_MS) history.delete(hex);
  }
}

// ---------------------------------------------------------------- flights

function normalizeAircraft(ac, center) {
  if (typeof ac?.lat !== "number" || typeof ac?.lon !== "number") return null;
  const onGround = ac.alt_baro === "ground";
  const altitudeFt = onGround ? 0 : Number.isFinite(ac.alt_baro) ? ac.alt_baro : Number.isFinite(ac.alt_geom) ? ac.alt_geom : null;
  const track = Number.isFinite(ac.track) ? ac.track : Number.isFinite(ac.true_heading) ? ac.true_heading : null;
  const hex = String(ac.hex || "").toLowerCase();
  return {
    hex,
    callsign: String(ac.flight || "").trim(),
    registration: String(ac.r || "").trim(),
    type: String(ac.t || "").trim(),
    description: String(ac.desc || "").trim(),
    category: String(ac.category || ""),
    lat: ac.lat,
    lon: ac.lon,
    altitudeFt,
    onGround,
    groundSpeedKt: Number.isFinite(ac.gs) ? ac.gs : null,
    track,
    verticalRateFpm: Number.isFinite(ac.baro_rate) ? ac.baro_rate : Number.isFinite(ac.geom_rate) ? ac.geom_rate : null,
    squawk: String(ac.squawk || ""),
    emergency: ac.emergency && ac.emergency !== "none" ? String(ac.emergency) : "",
    seenPos: Number.isFinite(ac.seen_pos) ? ac.seen_pos : 0,
    distanceKm: distanceKm(center.lat, center.lon, ac.lat, ac.lon),
    bearing: bearingDeg(center.lat, center.lon, ac.lat, ac.lon),
  };
}

async function fetchPositions(lat, lon, radiusNm) {
  const errors = [];
  for (const source of POINT_SOURCES) {
    try {
      const url = source.url(lat.toFixed(4), lon.toFixed(4), Math.ceil(radiusNm));
      // One shared answer per area for 20 s keeps us polite to the feeders.
      const json = await cached(`point:${url}`, 20_000, () => fetchJson(url));
      return { source: source.name, aircraft: Array.isArray(json.ac) ? json.ac : [], now: json.now };
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(`No flight source reachable (${errors.join("; ")})`);
}

// trace_recent entries: [secondsAfterTimestamp, lat, lon, alt|"ground", gs, track, ...]
async function fetchTrail(hex, sinceMs) {
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  const json = await cached(`trace:${hex}`, 45_000, () => fetchJson(TRACE_URL(hex), { timeoutMs: 5000 }));
  if (!json || !Array.isArray(json.trace)) return null;
  const base = Number(json.timestamp) * 1000;
  return json.trace
    .filter((p) => Array.isArray(p) && Number.isFinite(p[1]) && Number.isFinite(p[2]) && base + p[0] * 1000 >= sinceMs)
    .map((p) => [p[2], p[1]]);
}

function trailFromHistory(hex, sinceMs) {
  return (history.get(hex) || []).filter((p) => p.t >= sinceMs).map((p) => [p.lon, p.lat]);
}

async function fetchRoutes(flights) {
  const planes = flights
    .filter((f) => f.callsign)
    .map((f) => ({ callsign: f.callsign, lat: f.lat, lng: f.lon }));
  if (!planes.length) return new Map();
  const key = `routes:${planes.map((p) => p.callsign).sort().join(",")}`;
  const json = await cached(key, 10 * 60_000, async () => {
    let lastError;
    for (const url of ROUTESET_URLS) {
      try {
        const result = await fetchJson(url, { method: "POST", body: { planes }, timeoutMs: 6000 });
        if (Array.isArray(result) && result.length) return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return [];
  });
  const routes = new Map();
  for (const r of Array.isArray(json) ? json : []) {
    if (!r?.callsign || r.plausible === 0 || r.plausible === false) continue;
    const airports = Array.isArray(r._airports) ? r._airports : [];
    const codes = String(r._airport_codes_iata || r.airport_codes || "").split("-").filter(Boolean);
    if (codes.length < 2 && airports.length < 2) continue;
    const from = airports[0] || {};
    const to = airports.at(-1) || {};
    routes.set(String(r.callsign).trim(), {
      from: from.iata || from.icao || codes[0] || "",
      to: to.iata || to.icao || codes.at(-1) || "",
      fromName: from.location || from.name || "",
      toName: to.location || to.name || "",
    });
  }
  return routes;
}

// ---------------------------------------------------------------- basemap

async function readCell(key) {
  return cached(`cell:${key}`, 60 * 60_000, async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(basemapDir, `${key}.json`), "utf8"));
    } catch {
      return null;
    }
  });
}

async function loadBasemap(bbox) {
  const out = { land: [], lakes: [], urban: [], rivers: [], borders: [], roads: [], places: [], airports: [] };
  const la0 = Math.floor(bbox.south / CELL_DEG), la1 = Math.floor(bbox.north / CELL_DEG);
  const lo0 = Math.floor(bbox.west / CELL_DEG), lo1 = Math.floor(bbox.east / CELL_DEG);
  if ((la1 - la0 + 1) * (lo1 - lo0 + 1) > 400) return { ...out, tooLarge: true };
  let found = 0;
  for (let la = la0; la <= la1; la += 1) {
    for (let lo = lo0; lo <= lo1; lo += 1) {
      const c = await readCell(cellKey(la, lo));
      if (!c) continue;
      found += 1;
      for (const layer of Object.keys(out)) if (Array.isArray(c[layer])) out[layer].push(...c[layer]);
    }
  }
  const inside = (p) => p.x >= bbox.west && p.x <= bbox.east && p.y >= bbox.south && p.y <= bbox.north;
  out.places = out.places.filter(inside);
  out.airports = out.airports.filter(inside);
  // A cell file only exists where there is land or water detail. None at all
  // means open ocean.
  out.allWater = found === 0;
  return out;
}

// Names the home location from the offline GeoNames towns: the closest one
// within 25 km, with bigger towns pulling a little harder so a point in a
// city's suburb is named after the city rather than a small district.
async function nearestPlace(lat, lon) {
  const la = Math.floor(lat / CELL_DEG), lo = Math.floor(lon / CELL_DEG);
  let best = null;
  for (let dla = -1; dla <= 1; dla += 1) {
    for (let dlo = -1; dlo <= 1; dlo += 1) {
      const c = await readCell(cellKey(la + dla, lo + dlo));
      for (const p of c?.places || []) {
        const km = distanceKm(lat, lon, p.y, p.x);
        if (km > 25) continue;
        const score = km / Math.log10(Math.max(p.pop || 0, 5000));
        if (!best || score < best.score) best = { name: p.n, distanceKm: km, score };
      }
    }
  }
  return best && { name: best.name, distanceKm: Math.round(best.distanceKm * 10) / 10 };
}

// A plane's photo rarely changes, so misses are cached as long as hits.
async function fetchPhoto(hex) {
  return cached(`photo:${hex}`, 24 * 60 * 60_000, async () => {
    try {
      const json = await fetchJson(PHOTO_URL(hex), { timeoutMs: 4000 });
      const p = Array.isArray(json?.photos) ? json.photos[0] : null;
      const src = p?.thumbnail_large?.src || p?.thumbnail?.src;
      if (!src) return null;
      return { src, photographer: String(p.photographer || ""), link: String(p.link || "") };
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------- sample data

function sampleFlights(center, now) {
  const demo = [
    { callsign: "DLH4TK", type: "A20N", registration: "D-AINK", alt: 36000, gs: 452, track: 118, vr: 0, km: 7, brg: 300, from: "FRA", to: "IST", fromName: "Frankfurt", toName: "Istanbul" },
    { callsign: "RYR82LP", type: "B38M", registration: "9H-VUE", alt: 23800, gs: 398, track: 245, vr: -1400, km: 14, brg: 60, from: "VIE", to: "BGY", fromName: "Vienna", toName: "Bergamo" },
    { callsign: "WZZ5NC", type: "A21N", registration: "HA-LVQ", alt: 38000, gs: 471, track: 290, vr: 0, km: 19, brg: 170, from: "OTP", to: "EIN", fromName: "Bucharest", toName: "Eindhoven" },
    { callsign: "AUA91W", type: "E195", registration: "OE-LWP", alt: 11200, gs: 288, track: 20, vr: 1900, km: 11, brg: 210, from: "LJU", to: "VIE", fromName: "Ljubljana", toName: "Vienna" },
    { callsign: "UAE7TR", type: "B77W", registration: "A6-EGO", alt: 34000, gs: 489, track: 138, vr: 0, km: 25, brg: 335, from: "MUC", to: "DXB", fromName: "Munich", toName: "Dubai" },
    { callsign: "OEFBH", type: "C172", registration: "OE-FBH", alt: 3400, gs: 96, track: 75, vr: 0, km: 5, brg: 115, from: "", to: "" },
    { callsign: "THY1RL", type: "A333", registration: "TC-JNM", alt: 37000, gs: 466, track: 310, vr: 0, km: 30, brg: 100 },
    { callsign: "SWR25K", type: "BCS3", registration: "HB-JCO", alt: 30000, gs: 440, track: 265, vr: 0, km: 33, brg: 250 },
  ];
  return demo.map((d, i) => {
    const [lat, lon] = destination(center.lat, center.lon, d.brg, d.km);
    const minutes = 3;
    const legKm = (d.gs * 1.852 * minutes) / 60;
    const trail = [];
    for (let s = 8; s >= 0; s -= 1) {
      const [tl, tn] = destination(lat, lon, (d.track + 180 + Math.sin(s + i) * 4) % 360, (legKm * s) / 8);
      trail.push([tn, tl]);
    }
    return {
      hex: `demo${i}`,
      callsign: d.callsign,
      registration: d.registration,
      type: d.type,
      description: "",
      category: d.type === "C172" ? "A1" : "A3",
      lat,
      lon,
      altitudeFt: d.alt,
      onGround: false,
      groundSpeedKt: d.gs,
      track: d.track,
      verticalRateFpm: d.vr,
      squawk: "",
      emergency: "",
      seenPos: 0,
      distanceKm: d.km,
      bearing: d.brg,
      trail,
      route: d.from ? { from: d.from, to: d.to, fromName: d.fromName, toName: d.toName } : null,
    };
  });
}

// ---------------------------------------------------------------- handler

export default async function handler({ query = {} } = {}) {
  const now = Date.now();
  const latitude = num(query.latitude, 46.0569, -85, 85);
  const longitude = num(query.longitude, 14.5058, -180, 180);
  const zoom = num(query.zoom, 9, 4, 14);
  const width = Math.round(num(query.width, 480, 100, 4000));
  const height = Math.round(num(query.height, 480, 100, 4000));
  const trailMinutes = num(query.trailMinutes, 3, 0, 30);
  const includeGround = bool(query.includeGround, false);
  const showRoutes = bool(query.showRoutes, true);
  const minAltitude = num(query.minAltitudeFt, 0, 0, 60000);
  const maxAltitude = num(query.maxAltitudeFt, 60000, 0, 60000);
  const sample = bool(query.sampleData, false);
  const photoCount = Math.round(num(query.photos, 0, 0, 12));
  const withBasemap = query.basemap !== "none";

  const projection = createProjection({ latitude, longitude, zoom, width, height });
  const { bbox } = projection;
  const center = { lat: latitude, lon: longitude };
  // Radius to the farthest map corner, plus a margin so trails entering the
  // map are drawn too. adsb.lol accepts up to 250 nm.
  const cornerKm = Math.max(
    distanceKm(latitude, longitude, bbox.north, bbox.west),
    distanceKm(latitude, longitude, bbox.south, bbox.east),
  );
  const radiusNm = Math.min(250, Math.max(5, (cornerKm * 1.1) / KM_PER_NM));

  const basemapPromise = withBasemap ? loadBasemap(bbox).catch(() => null) : Promise.resolve(null);
  const placePromise = nearestPlace(latitude, longitude).catch(() => null);

  let flights = [];
  let source = "";
  let error = "";
  let upstreamTotal = 0;

  if (sample) {
    source = "demo";
    flights = sampleFlights(center, now).sort((a, b) => a.distanceKm - b.distanceKm);
    upstreamTotal = flights.length;
  } else {
    try {
      const result = await fetchPositions(latitude, longitude, radiusNm);
      source = result.source;
      upstreamTotal = result.aircraft.length;
      const all = result.aircraft.map((ac) => normalizeAircraft(ac, center)).filter(Boolean);
      for (const f of all) remember(f, now);
      const margin = 0.02;
      const inView = (f) =>
        f.lat <= bbox.north + margin && f.lat >= bbox.south - margin && f.lon >= bbox.west - margin && f.lon <= bbox.east + margin;
      flights = all
        .filter((f) => f.seenPos < 60)
        .filter((f) => includeGround || !f.onGround)
        .filter((f) => f.onGround || f.altitudeFt === null || (f.altitudeFt >= minAltitude && f.altitudeFt <= maxAltitude))
        .filter(inView)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, MAX_MAP_FLIGHTS);

      const since = now - trailMinutes * 60_000;
      if (trailMinutes > 0) {
        const trails = await mapLimit(flights.slice(0, MAX_TRACE_FETCHES), 6, (f) => fetchTrail(f.hex, since));
        flights.forEach((f, i) => {
          const fromTrace = trails[i];
          f.trail = fromTrace && fromTrace.length > 1 ? fromTrace : trailFromHistory(f.hex, since);
          f.trail.push([f.lon, f.lat]);
        });
      } else {
        flights.forEach((f) => (f.trail = []));
      }

      if (showRoutes) {
        try {
          const routes = await fetchRoutes(flights.slice(0, 12));
          for (const f of flights) f.route = routes.get(f.callsign) || null;
        } catch {
          for (const f of flights) f.route = null;
        }
      }

      if (photoCount > 0) {
        const listed = flights.slice(0, photoCount);
        const photos = await mapLimit(listed, 4, (f) => fetchPhoto(f.hex));
        listed.forEach((f, i) => (f.photo = photos[i]));
      }
    } catch (e) {
      error = e.message || String(e);
    }
  }

  const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    ok: !error,
    error,
    sample,
    source,
    retrievedAt: new Date(now).toISOString(),
    center: { latitude, longitude },
    place: await placePromise,
    zoom,
    radiusNm: Math.round(radiusNm),
    bbox,
    upstreamTotal,
    flights: flights.map((f) => ({
      ...f,
      lat: round(f.lat),
      lon: round(f.lon),
      distanceKm: Math.round(f.distanceKm * 10) / 10,
      bearing: Math.round(f.bearing),
      trail: (f.trail || []).map(([x, y]) => [round(x), round(y)]),
    })),
    basemap: await basemapPromise,
  };
}
