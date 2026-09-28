// Builds the offline basemap used behind the flights.
//
// Reads Natural Earth 1:10m GeoJSON layers (public domain) plus GeoNames towns
// (CC BY 4.0, via the all-the-cities package) and writes compact
// 2x2 degree cells to data/basemap/<lat>_<lon>.json. The API route loads only
// the cells that intersect the requested map, so no tile server is needed and
// the lines stay crisp on Spectra 6 panels.
//
// Usage:
//   node scripts/build-basemap.mjs [path/to/natural-earth-geojson]
//
// The source folder must contain the ne_10m_*.geojson files listed below, as
// published at https://github.com/nvkelso/natural-earth-vector/tree/master/geojson

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CELL_DEG, cellKey } from "../assets/geo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(process.argv[2] || path.join(root, ".natural-earth"));
const outDir = path.join(root, "data", "basemap");

const PRECISION = 1000; // ~100 m, plenty at the zoom levels offered
const SIMPLIFY = 0.0006; // degrees, Douglas-Peucker tolerance

const round = (v) => Math.round(v * PRECISION) / PRECISION;

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function clean(points, closed) {
  const out = [];
  for (const [x, y] of simplify(points, SIMPLIFY)) {
    const p = [round(x), round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (closed && out.length && (out[0][0] !== out.at(-1)[0] || out[0][1] !== out.at(-1)[1])) out.push(out[0]);
  return out;
}

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Sutherland-Hodgman clip of one ring against an axis-aligned box.
function clipRing(ring, box) {
  let pts = ring;
  const edges = [
    (p) => p[0] >= box.minX, (a, b) => { const t = (box.minX - a[0]) / (b[0] - a[0]); return [box.minX, a[1] + t * (b[1] - a[1])]; },
    (p) => p[0] <= box.maxX, (a, b) => { const t = (box.maxX - a[0]) / (b[0] - a[0]); return [box.maxX, a[1] + t * (b[1] - a[1])]; },
    (p) => p[1] >= box.minY, (a, b) => { const t = (box.minY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), box.minY]; },
    (p) => p[1] <= box.maxY, (a, b) => { const t = (box.maxY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), box.maxY]; },
  ];
  for (let e = 0; e < edges.length; e += 2) {
    const inside = edges[e];
    const cut = edges[e + 1];
    const out = [];
    for (let i = 0; i < pts.length; i += 1) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}

// Split a polyline into the pieces that fall inside a box (with one point of overlap).
function clipLine(line, box) {
  const pieces = [];
  let cur = [];
  const inBox = (p) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
  for (let i = 0; i < line.length; i += 1) {
    const p = line[i];
    if (inBox(p)) {
      if (!cur.length && i > 0) cur.push(line[i - 1]);
      cur.push(p);
    } else if (cur.length) {
      cur.push(p);
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

const cells = new Map();
function cell(key) {
  if (!cells.has(key)) cells.set(key, {});
  return cells.get(key);
}
function push(key, layer, value) {
  const c = cell(key);
  (c[layer] ||= []).push(value);
}

function cellsFor(bb) {
  const keys = [];
  const la0 = Math.floor(bb.minY / CELL_DEG), la1 = Math.floor(bb.maxY / CELL_DEG);
  const lo0 = Math.floor(bb.minX / CELL_DEG), lo1 = Math.floor(bb.maxX / CELL_DEG);
  for (let la = la0; la <= la1; la += 1) {
    for (let lo = lo0; lo <= lo1; lo += 1) {
      keys.push({ la, lo, box: { minX: lo * CELL_DEG, maxX: (lo + 1) * CELL_DEG, minY: la * CELL_DEG, maxY: (la + 1) * CELL_DEG } });
    }
  }
  return keys;
}

function addPolygon(layer, rings, props) {
  // Outer ring decides the cells; holes are clipped alongside.
  const bb = bboxOf(rings[0]);
  for (const { la, lo, box } of cellsFor(bb)) {
    const clipped = [];
    for (const ring of rings) {
      const r = clipRing(ring, box);
      if (r.length >= 3) clipped.push(clean(r, true));
    }
    if (clipped.length && clipped[0].length >= 4) push(cellKey(la, lo), layer, props ? { ...props, p: clipped } : clipped);
  }
}

function addLine(layer, line, props) {
  const bb = bboxOf(line);
  for (const { la, lo, box } of cellsFor(bb)) {
    for (const piece of clipLine(line, box)) {
      const c = clean(piece, false);
      if (c.length >= 2) push(cellKey(la, lo), layer, props ? { ...props, l: c } : c);
    }
  }
}

function addPoint(layer, lon, lat, props) {
  push(cellKey(Math.floor(lat / CELL_DEG), Math.floor(lon / CELL_DEG)), layer, { ...props, x: round(lon), y: round(lat) });
}

async function load(name) {
  const file = path.join(sourceDir, `${name}.geojson`);
  const json = JSON.parse(await fs.readFile(file, "utf8"));
  console.log(`${name}: ${json.features.length} features`);
  return json.features;
}

function eachPolygon(geom, fn) {
  if (!geom) return;
  if (geom.type === "Polygon") fn(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(fn);
}
function eachLine(geom, fn) {
  if (!geom) return;
  if (geom.type === "LineString") fn(geom.coordinates);
  else if (geom.type === "MultiLineString") geom.coordinates.forEach(fn);
}

// Large polygons (continents) are pre-split into 10 degree chunks so the
// per-cell clip stays fast.
function addBigPolygon(layer, rings) {
  const bb = bboxOf(rings[0]);
  if (bb.maxX - bb.minX <= 10 && bb.maxY - bb.minY <= 10) {
    addPolygon(layer, rings);
    return;
  }
  for (let y = Math.floor(bb.minY / 10) * 10; y < bb.maxY; y += 10) {
    for (let x = Math.floor(bb.minX / 10) * 10; x < bb.maxX; x += 10) {
      const box = { minX: x, maxX: x + 10, minY: y, maxY: y + 10 };
      const outer = clipRing(rings[0], box);
      if (outer.length < 3) continue;
      const holes = rings.slice(1).map((r) => clipRing(r, box)).filter((r) => r.length >= 3);
      addPolygon(layer, [outer, ...holes]);
    }
  }
}

const land = await load("ne_10m_land");
for (const f of land) eachPolygon(f.geometry, (rings) => addBigPolygon("land", rings));

for (const name of ["ne_10m_lakes", "ne_10m_lakes_europe"]) {
  for (const f of await load(name)) eachPolygon(f.geometry, (rings) => addBigPolygon("lakes", rings));
}

for (const f of await load("ne_10m_urban_areas")) eachPolygon(f.geometry, (rings) => addPolygon("urban", rings));

for (const name of ["ne_10m_rivers_lake_centerlines", "ne_10m_rivers_europe"]) {
  for (const f of await load(name)) {
    if (f.properties?.featurecla && !/River|Lake Centerline|Canal/i.test(f.properties.featurecla)) continue;
    eachLine(f.geometry, (line) => addLine("rivers", line));
  }
}

for (const f of await load("ne_10m_admin_0_boundary_lines_land")) eachLine(f.geometry, (line) => addLine("borders", line));

for (const f of await load("ne_10m_roads")) {
  const type = f.properties?.type || "";
  if (/ferry/i.test(type) || /ferry/i.test(f.properties?.featurecla || "")) continue;
  const major = /Major Highway/i.test(type) ? 1 : 0;
  eachLine(f.geometry, (line) => addLine("roads", line, { m: major }));
}

// Place labels come from GeoNames (CC BY 4.0) via the all-the-cities
// package, which has far more towns than Natural Earth. Rank 1 is a big city.
const { default: cities } = await import("all-the-cities");
let placeCount = 0;
for (const c of cities) {
  if (!(c.population >= 5000)) continue;
  const [lon, lat] = c.loc.coordinates;
  const pop = c.population;
  const r = pop >= 1e6 ? 1 : pop >= 3e5 ? 2 : pop >= 1e5 ? 3 : pop >= 3e4 ? 4 : pop >= 1e4 ? 5 : 6;
  addPoint("places", lon, lat, { n: c.name, r, pop });
  placeCount += 1;
}
console.log(`places: ${placeCount} towns from GeoNames`);

for (const f of await load("ne_10m_airports")) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  addPoint("airports", lon, lat, {
    n: p.name,
    iata: p.iata_code || "",
    icao: p.gps_code || p.ident || "",
    r: Number(p.scalerank ?? 10),
    k: /major/i.test(p.type || "") ? "major" : /military/i.test(p.type || "") ? "military" : "mid",
  });
}

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
let bytes = 0;
for (const [key, value] of cells) {
  const body = JSON.stringify(value);
  bytes += body.length;
  await fs.writeFile(path.join(outDir, `${key}.json`), body);
}
console.log(`wrote ${cells.size} cells, ${(bytes / 1e6).toFixed(1)} MB`);
