import {
  waitForPayload,
  getSettings,
  getQuerySettings,
  mergeSettings,
  loadLanguageJson,
  applyColorTheme,
  markLoading,
  markReady,
  markError,
  escapeHtml,
} from "./paperless.js";
import { createProjection, KM_PER_NM } from "./geo.js";

const defaults = {
  color: "blue-light",
  title: "",
  locationName: "",
  latitude: 46.0569,
  longitude: 14.5058,
  zoom: 9,
  listCount: 8,
  trailMinutes: 3,
  units: "metric",
  showRoutes: true,
  includeGround: false,
  minAltitudeFt: 0,
  basemap: "detailed",
  showRangeRings: true,
  timeZone: "Europe/Ljubljana",
  sampleData: false,
  showPhotos: true,
};

// Each listed flight (up to 12) gets a unique look for its badge, plane,
// trail and list tile. The panel has only five usable inks and the frame's
// optimiser snaps mixed colours to the nearest ink, so uniqueness comes from
// ink x style:
//   1-5   solid:   filled round badge, filled plane, solid trail
//   6-10  outline: ring badge, filled plane, dashed trail
//   11-12 square:  filled square badge, filled plane, dotted trail
// Yellow gets a dark outline so it holds up on white.
const INKS = [
  { fill: "var(--pp-blue)", ink: "var(--pp-white)" },
  { fill: "var(--pp-red)", ink: "var(--pp-white)" },
  // Dark green on purpose: the optimiser matches against how the panel's
  // inks really look, and pure #00FF00 lands on yellow.
  { fill: "#1f7a3f", ink: "var(--pp-white)" },
  { fill: "var(--pp-yellow)", ink: "var(--pp-black)", outline: true },
  { fill: "var(--pp-fg)", ink: "var(--pp-bg)" },
];
const STYLES = ["solid", "ring", "square"];
function flightColor(n) {
  const i = (n - 1) % (INKS.length * STYLES.length);
  return { ...INKS[i % INKS.length], style: STYLES[Math.floor(i / INKS.length)] };
}
function trailDash(color, u) {
  if (color.style === "ring") return `${6 * u} ${6 * u}`;
  if (color.style === "square") return `${0.1 * u} ${6.5 * u}`;
  return undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (sel) => document.querySelector(sel);

// Airliner silhouette pointing north, roughly 22 units long.
const PLANE_PATH =
  "M0,-11C1,-11 1.6,-10 1.6,-8.5L1.6,-3.2L10.5,2L10.5,4.2L1.6,1.6L1.2,7L4.2,9.2L4.2,10.8L0,9.8L-4.2,10.8L-4.2,9.2L-1.2,7L-1.6,1.6L-10.5,4.2L-10.5,2L-1.6,-3.2L-1.6,-8.5C-1.6,-10 -1,-11 0,-11Z";

function toBool(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === "true" || v === 1 || v === "1";
}
function toNum(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function normalize(s) {
  return {
    ...s,
    title: String(s.title ?? "").slice(0, 60),
    locationName: String(s.locationName ?? "").slice(0, 60),
    latitude: toNum(s.latitude, defaults.latitude, -85, 85),
    longitude: toNum(s.longitude, defaults.longitude, -180, 180),
    zoom: toNum(s.zoom, defaults.zoom, 5, 13),
    listCount: Math.round(toNum(s.listCount, defaults.listCount, 0, 12)),
    trailMinutes: Math.round(toNum(s.trailMinutes, defaults.trailMinutes, 0, 15)),
    minAltitudeFt: toNum(s.minAltitudeFt, 0, 0, 40000),
    units: ["aviation", "metric", "imperial"].includes(s.units) ? s.units : defaults.units,
    basemap: ["detailed", "simple", "none"].includes(s.basemap) ? s.basemap : defaults.basemap,
    showRoutes: toBool(s.showRoutes, true),
    includeGround: toBool(s.includeGround, false),
    showRangeRings: toBool(s.showRangeRings, true),
    sampleData: toBool(s.sampleData, false),
    showPhotos: toBool(s.showPhotos, true),
    timeZone: String(s.timeZone || ""),
  };
}

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => (k in values ? values[k] : ""));
}

// ------------------------------------------------------------------ units

function unitsFor(kind, locale) {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  if (kind === "metric") {
    return {
      alt: (ft) => `${nf.format(Math.round((ft * 0.3048) / 10) * 10)} m`,
      speed: (kt) => `${nf.format(kt * 1.852)} km/h`,
      dist: (km) => `${km < 10 ? km.toFixed(1) : nf.format(km)} km`,
      ringUnitKm: 1,
      ringLabel: "km",
    };
  }
  if (kind === "imperial") {
    return {
      alt: (ft) => `${nf.format(Math.round(ft / 10) * 10)} ft`,
      speed: (kt) => `${nf.format(kt * 1.15078)} mph`,
      dist: (km) => `${(km / 1.609344).toFixed(km < 16 ? 1 : 0)} mi`,
      ringUnitKm: 1.609344,
      ringLabel: "mi",
    };
  }
  return {
    alt: (ft) => (ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${nf.format(Math.round(ft / 10) * 10)} ft`),
    speed: (kt) => `${nf.format(kt)} kt`,
    dist: (km) => `${(km / KM_PER_NM).toFixed(km / KM_PER_NM < 10 ? 1 : 0)} nm`,
    ringUnitKm: KM_PER_NM,
    ringLabel: "nm",
  };
}

// ------------------------------------------------------------------ svg helpers

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

function pathFromRings(rings, project) {
  let d = "";
  for (const ring of rings) {
    ring.forEach((pt, i) => {
      const [x, y] = project(pt);
      d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    d += "Z";
  }
  return d;
}
function pathFromLine(line, project) {
  return line
    .map((pt, i) => {
      const [x, y] = project(pt);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}

// Very small collision grid for labels.
function createPlacer(width, height) {
  const boxes = [];
  return {
    reserve(box) {
      boxes.push(box);
    },
    fits(box) {
      if (box.x < 2 || box.y < 2 || box.x + box.w > width - 2 || box.y + box.h > height - 2) return false;
      return !boxes.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
    },
  };
}

function textWidth(text, size, weight = 600) {
  const ctx = (textWidth.ctx ||= document.createElement("canvas").getContext("2d"));
  ctx.font = `${weight} ${size}px "Paperless Open Sans", sans-serif`;
  return ctx.measureText(text).width;
}

function niceRingStep(maxKm) {
  const steps = [0.5, 1, 2, 2.5, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200, 250, 500];
  return steps.find((s) => maxKm / s <= 3.2) || 500;
}

// ------------------------------------------------------------------ map

function drawMap({ svg, width, height, data, settings, listed, u, units }) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const projection = createProjection({ ...settings, width, height });
  const project = projection.project;
  const fg = "var(--pp-fg)";
  const bg = "var(--pp-bg)";
  const blue = "var(--pp-blue)";
  const red = "var(--pp-red)";

  const defs = el("defs", {}, svg);
  const water = el("pattern", { id: "water", patternUnits: "userSpaceOnUse", width: 6 * u, height: 5 * u }, defs);
  el("rect", { width: 6 * u, height: 5 * u, fill: bg }, water);
  el("rect", { y: 0, width: 6 * u, height: Math.max(1, 1 * u), fill: blue }, water);
  const dots = el("pattern", { id: "urban", patternUnits: "userSpaceOnUse", width: 4 * u, height: 4 * u }, defs);
  el("rect", { width: 4 * u, height: 4 * u, fill: bg }, dots);
  el("rect", { x: 1 * u, y: 1 * u, width: Math.max(1, 1.2 * u), height: Math.max(1, 1.2 * u), fill: fg }, dots);

  const placer = createPlacer(width, height);
  const basemap = data?.basemap;

  // Background: water where there is no land.
  const hasBasemap = settings.basemap !== "none" && basemap && !basemap.tooLarge;
  el("rect", { width, height, fill: hasBasemap ? "url(#water)" : bg }, svg);

  if (hasBasemap) {
    const g = el("g", {}, svg);
    if (basemap.land?.length) {
      const d = basemap.land.map((rings) => pathFromRings(rings, project)).join("");
      // Coast: a blue outline whose inner half is covered by the land fill,
      // so the clipped cell seams disappear and only the coast shows.
      el("path", { d, fill: "none", stroke: blue, "stroke-width": 3 * u, "stroke-linejoin": "round" }, g);
      el("path", { d, fill: bg, stroke: "none", "fill-rule": "evenodd" }, g);
    }
    if (settings.basemap === "detailed" && basemap.urban?.length) {
      const d = basemap.urban.map((rings) => pathFromRings(rings, project)).join("");
      el("path", { d, fill: "url(#urban)", "fill-rule": "evenodd" }, g);
    }
    if (basemap.lakes?.length) {
      const d = basemap.lakes.map((rings) => pathFromRings(rings, project)).join("");
      el("path", { d, fill: "url(#water)", stroke: blue, "stroke-width": 1.2 * u, "fill-rule": "evenodd" }, g);
    }
    if (basemap.rivers?.length) {
      const d = basemap.rivers.map((line) => pathFromLine(line, project)).join("");
      el("path", { d, fill: "none", stroke: blue, "stroke-width": 1.6 * u, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
    }
    if (settings.basemap === "detailed" && basemap.roads?.length) {
      const minor = basemap.roads.filter((r) => !r.m).map((r) => pathFromLine(r.l, project)).join("");
      const major = basemap.roads.filter((r) => r.m).map((r) => pathFromLine(r.l, project)).join("");
      if (minor) el("path", { d: minor, fill: "none", stroke: fg, "stroke-width": 0.9 * u, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
      if (major) el("path", { d: major, fill: "none", stroke: fg, "stroke-width": 1.8 * u, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
    }
    if (basemap.borders?.length) {
      const d = basemap.borders.map((line) => pathFromLine(line, project)).join("");
      el("path", { d, fill: "none", stroke: bg, "stroke-width": 4 * u }, g);
      el("path", { d, fill: "none", stroke: fg, "stroke-width": 1.6 * u, "stroke-dasharray": `${7 * u} ${3 * u} ${1.5 * u} ${3 * u}` }, g);
    }
  }

  // Range rings around home.
  const [hx, hy] = project([settings.longitude, settings.latitude]);
  const rings = el("g", {}, svg);
  const ringLabels = el("g");
  if (settings.showRangeRings) {
    const maxKm = (Math.min(width, height) / 2 / projection.pxPerKm) * 0.98;
    const stepUnits = niceRingStep(maxKm / units.ringUnitKm);
    for (let r = stepUnits; r * units.ringUnitKm <= maxKm * 1.45; r += stepUnits) {
      const rPx = r * units.ringUnitKm * projection.pxPerKm;
      el("circle", { cx: hx, cy: hy, r: rPx, fill: "none", stroke: fg, "stroke-width": 1.6 * u, "stroke-dasharray": `${4 * u} ${4 * u}` }, rings);
      // Label on the ring towards the lower right.
      const angle = Math.PI / 4;
      const lx = hx + rPx * Math.cos(angle);
      const ly = hy + rPx * Math.sin(angle);
      const label = `${r} ${units.ringLabel}`;
      const size = 11 * u;
      const w = textWidth(label, size, 700);
      const box = { x: lx - w / 2 - 2 * u, y: ly - size / 2 - 2 * u, w: w + 4 * u, h: size + 4 * u };
      if (placer.fits(box)) {
        placer.reserve(box);
        el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: bg }, ringLabels);
        const t = el("text", { x: lx, y: ly + size * 0.36, "text-anchor": "middle", "font-size": size, "font-weight": 700, fill: fg }, ringLabels);
        t.textContent = label;
      }
    }
  }

  // Home marker, reserved first so labels avoid it.
  const home = el("g", {}, svg);
  el("circle", { cx: hx, cy: hy, r: 8 * u, fill: bg, stroke: blue, "stroke-width": 3 * u }, home);
  el("circle", { cx: hx, cy: hy, r: 2.6 * u, fill: blue }, home);
  placer.reserve({ x: hx - 10 * u, y: hy - 10 * u, w: 20 * u, h: 20 * u });

  // Flights: trails, then planes, then number badges.
  const flights = data?.flights || [];
  const listedIndex = new Map(listed.map((f, i) => [f.hex, i + 1]));
  const trailLayer = el("g", {}, svg);
  const planeLayer = el("g", {}, svg);
  const labelLayer = el("g", {}, svg);

  // Unlisted trails first and thin, so the coloured ones stay on top.
  const byListed = [...flights].sort((a, b) => (listedIndex.has(a.hex) ? 1 : 0) - (listedIndex.has(b.hex) ? 1 : 0));
  for (const f of byListed) {
    if (f.trail?.length > 1) {
      const d = pathFromLine(f.trail, project);
      const n = listedIndex.get(f.hex);
      const color = n ? flightColor(n) : null;
      const line = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      el("path", { ...line, d, stroke: color?.outline ? fg : bg, "stroke-width": (n ? 6.5 : 4) * u }, trailLayer);
      el("path", {
        ...line, d, stroke: color ? color.fill : fg, "stroke-width": (n ? 3.5 : 1.4) * u,
        "stroke-dasharray": color ? trailDash(color, u) : undefined,
      }, trailLayer);
    }
  }

  // Draw far planes first so the closest end up on top; listed planes above the rest.
  const byDistance = [...flights].sort(
    (a, b) => (listedIndex.has(a.hex) ? 1 : 0) - (listedIndex.has(b.hex) ? 1 : 0) || b.distanceKm - a.distanceKm,
  );
  for (const f of byDistance) {
    const [x, y] = project([f.lon, f.lat]);
    if (x < -20 * u || y < -20 * u || x > width + 20 * u || y > height + 20 * u) continue;
    const small = /^A[12]$|^A7$|^B/.test(f.category || "");
    const scale = (small ? 0.8 : 1.1) * u;
    const rot = Number.isFinite(f.track) ? f.track : 0;
    const g = el("g", { transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${scale.toFixed(3)})` }, planeLayer);
    const n = listedIndex.get(f.hex);
    if (n) {
      const color = flightColor(n);
      el("path", { d: PLANE_PATH, fill: "none", stroke: bg, "stroke-width": 4, "stroke-linejoin": "round" }, g);
      // Filled in the flight's colour with a thin dark outline.
      el("path", { d: PLANE_PATH, fill: color.fill, stroke: fg, "stroke-width": 1, "stroke-linejoin": "round" }, g);
    } else {
      // Others: hollow, so the numbered flights stand out.
      el("path", { d: PLANE_PATH, fill: bg, stroke: f.emergency ? red : fg, "stroke-width": 1.8, "stroke-linejoin": "round" }, g);
    }
    placer.reserve({ x: x - 11 * scale, y: y - 11 * scale, w: 22 * scale, h: 22 * scale });
  }

  for (const f of listed) {
    const n = listedIndex.get(f.hex);
    const [x, y] = project([f.lon, f.lat]);
    const r = 10 * u;
    // Try positions around the plane, preferring the side away from its heading.
    const offsets = [
      [17, -17], [-17, -17], [17, 17], [-17, 17], [24, 0], [-24, 0], [0, -24], [0, 24],
    ].map(([dx, dy]) => [dx * u, dy * u]);
    let pos = offsets.find(([dx, dy]) => placer.fits({ x: x + dx - r, y: y + dy - r, w: 2 * r, h: 2 * r })) || offsets[0];
    const bx = Math.min(width - r - 1, Math.max(r + 1, x + pos[0]));
    const by = Math.min(height - r - 1, Math.max(r + 1, y + pos[1]));
    placer.reserve({ x: bx - r, y: by - r, w: 2 * r, h: 2 * r });
    const color = flightColor(n);
    const ring = color.style === "ring";
    const shape = color.style === "square"
      ? (attrs) => el("rect", { x: bx - r, y: by - r, width: 2 * r, height: 2 * r, rx: 2.5 * u, ...attrs }, labelLayer)
      : (attrs) => el("circle", { cx: bx, cy: by, r, ...attrs }, labelLayer);
    shape({ fill: ring ? bg : color.fill, stroke: bg, "stroke-width": 2 * u });
    // Ring style: thick coloured ring, number in the colour (dark for yellow).
    if (ring) {
      el("circle", { cx: bx, cy: by, r: r - 1.6 * u, fill: "none", stroke: color.fill, "stroke-width": 3.2 * u }, labelLayer);
      if (color.outline) el("circle", { cx: bx, cy: by, r: r - 0.1 * u, fill: "none", stroke: fg, "stroke-width": 0.8 * u }, labelLayer);
    } else if (color.outline) {
      shape({ fill: "none", stroke: fg, "stroke-width": 1 * u });
    }
    const textFill = ring ? (color.outline ? fg : color.fill) : color.ink;
    const t = el("text", { x: bx, y: by + r * 0.42, "text-anchor": "middle", "font-size": (n > 9 ? 11 : 13) * u, "font-weight": 800, fill: textFill }, labelLayer);
    t.textContent = String(n);
  }

  // Place and airport labels go last into free space so they never cover planes.
  if (hasBasemap) {
    const labels = el("g", {}, svg);
    const places = (basemap.places || [])
      .slice()
      .sort((a, b) => a.r - b.r || b.pop - a.pop)
      .slice(0, 60);
    const maxPlaces = Math.round((width * height) / (26000 * u * u)) + 3;
    let placed = 0;
    for (const p of places) {
      if (placed >= maxPlaces) break;
      const [x, y] = project([p.x, p.y]);
      const size = (p.r <= 3 ? 13 : 11) * u;
      const name = String(p.n || "");
      if (!name) continue;
      const w = textWidth(name, size, p.r <= 3 ? 700 : 600);
      const candidates = [
        { tx: x + 6 * u, ty: y + size * 0.35, anchor: "start", box: { x: x + 5 * u, y: y - size * 0.65, w: w + 3 * u, h: size * 1.2 } },
        { tx: x - 6 * u, ty: y + size * 0.35, anchor: "end", box: { x: x - 8 * u - w, y: y - size * 0.65, w: w + 3 * u, h: size * 1.2 } },
        { tx: x, ty: y - 6 * u, anchor: "middle", box: { x: x - w / 2 - 2 * u, y: y - 7 * u - size, w: w + 4 * u, h: size * 1.2 } },
      ];
      const dotBox = { x: x - 3 * u, y: y - 3 * u, w: 6 * u, h: 6 * u };
      // A town right at home shares the home marker instead of its own dot.
      const atHome = Math.hypot(x - hx, y - hy) < 12 * u;
      const c = candidates.find((cand) => placer.fits(cand.box) && (atHome || placer.fits(dotBox)));
      if (!c) continue;
      placer.reserve(c.box);
      if (!atHome) {
        placer.reserve(dotBox);
        el("circle", { cx: x, cy: y, r: 2.6 * u, fill: fg, stroke: bg, "stroke-width": 1.2 * u }, labels);
      }
      const t = el("text", {
        x: c.tx, y: c.ty, "text-anchor": c.anchor, "font-size": size, "font-weight": p.r <= 3 ? 700 : 600,
        fill: fg, stroke: bg, "stroke-width": 3.5 * u, "paint-order": "stroke", "stroke-linejoin": "round",
      }, labels);
      t.textContent = name;
      placed += 1;
    }

    const airports = (basemap.airports || []).filter((a) => a.k !== "military" && (a.iata || a.icao)).sort((a, b) => a.r - b.r).slice(0, 6);
    for (const a of airports) {
      const [x, y] = project([a.x, a.y]);
      const code = a.iata || a.icao;
      const size = 11 * u;
      const w = textWidth(code, size, 800);
      const box = { x: x - 7 * u, y: y - 7 * u, w: w + 18 * u, h: 14 * u };
      if (!placer.fits(box)) continue;
      placer.reserve(box);
      const g = el("g", {}, labels);
      el("circle", { cx: x, cy: y, r: 5.5 * u, fill: bg, stroke: blue, "stroke-width": 2 * u }, g);
      el("path", { d: `M${x - 3.5 * u},${y + 2 * u}L${x + 3.5 * u},${y - 2 * u}`, stroke: blue, "stroke-width": 1.8 * u }, g);
      const t = el("text", {
        x: x + 8 * u, y: y + size * 0.36, "font-size": size, "font-weight": 800, fill: blue,
        stroke: bg, "stroke-width": 3 * u, "paint-order": "stroke",
      }, g);
      t.textContent = code;
    }
  }

  // Ring labels sit above trails so the distances stay readable.
  svg.appendChild(ringLabels);

  // Scale bar, bottom left.
  const scaleUnits = niceRingStep((width * 0.25) / projection.pxPerKm / units.ringUnitKm);
  const barPx = scaleUnits * units.ringUnitKm * projection.pxPerKm;
  if (barPx > 20 * u && barPx < width * 0.5) {
    const sx = 10 * u;
    const sy = height - 12 * u;
    const g = el("g", {}, svg);
    el("rect", { x: sx - 4 * u, y: sy - 18 * u, width: barPx + 8 * u, height: 26 * u, fill: bg }, g);
    el("path", { d: `M${sx},${sy - 5 * u}V${sy}H${sx + barPx}V${sy - 5 * u}`, fill: "none", stroke: fg, "stroke-width": 2 * u }, g);
    const t = el("text", { x: sx + barPx / 2, y: sy - 6 * u, "text-anchor": "middle", "font-size": 11 * u, "font-weight": 700, fill: fg }, g);
    t.textContent = `${scaleUnits} ${units.ringLabel}`;
  }
}

// ------------------------------------------------------------------ list

// Photo of the airframe when planespotters.net has one, otherwise a
// silhouette in the flight's colour. The number badge sits on its corner.
function planeTile(f, n, color, showPhotos) {
  const ring = color.style === "ring";
  const edge = color.outline ? "box-shadow:inset 0 0 0 1px var(--pp-fg), 0 0 0 1px var(--pp-fg)" : "";
  const badgeStyle = ring
    ? `background:var(--pp-bg);color:${color.outline ? "var(--pp-fg)" : color.fill};border:0.2em solid ${color.fill};${edge}`
    : `background:${color.fill};color:${color.ink};${edge}`;
  const badge = `<span class="badge badge-${color.style}${n > 9 ? " two-digit" : ""}" style="${badgeStyle}">${n}</span>`;
  if (!showPhotos) return badge;
  const plane = `fill="${color.fill}" stroke="var(--pp-fg)" stroke-width="0.8"`;
  const inner = f.photo?.src
    ? `<img src="${escapeHtml(f.photo.src)}" alt="" />${f.photo.photographer ? `<span class="credit">© ${escapeHtml(f.photo.photographer)}</span>` : ""}`
    : `<svg viewBox="-13 -13 26 26" aria-hidden="true"><path d="${PLANE_PATH}" transform="rotate(45)" ${plane} stroke-linejoin="round"/></svg>`;
  return `<span class="tile${f.photo?.src ? " photo" : ""}">${inner}${badge}</span>`;
}

// Drawn rather than typed: Open Sans has no arrow glyph.
const ARROW_RIGHT = `<svg class="arrow" viewBox="0 0 20 8" aria-hidden="true"><path d="M1 4H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 0.8L19.2 4L13 7.2Z" fill="currentColor"/></svg>`;

// List row: photo, flight number and origin -> destination.
function flightRow(f, n, messages, showPhotos) {
  const from = f.route ? f.route.fromName || f.route.from : "";
  const to = f.route ? f.route.toName || f.route.to : "";
  const route = [from, to].filter(Boolean).map(escapeHtml).join(ARROW_RIGHT);
  return `<li class="flight${showPhotos ? " with-tile" : ""}">
    ${planeTile(f, n, flightColor(n), showPhotos)}
    <div class="main">
      <div class="line1">
        <span class="cs">${escapeHtml(f.callsign || f.registration || f.hex.toUpperCase())}</span>
        ${f.emergency ? `<span class="emergency">${escapeHtml(messages.emergency || "EMERGENCY")}</span>` : ""}
      </div>
      ${route ? `<div class="line2">${route}</div>` : ""}
    </div>
  </li>`;
}

function formatCoords(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lon).toFixed(3)}° ${ew}`;
}

function formatTime(iso, locale, timeZone) {
  const date = iso ? new Date(iso) : new Date();
  const opts = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, timeZone ? { ...opts, timeZone } : opts).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(date);
  }
}

// ------------------------------------------------------------------ main

// GET keeps this compatible with every host: the paperlesspaper integrations
// server and all versions of the toolkit dev server. Nothing here is secret.
async function fetchData(settings, width, height) {
  const url = new URL("./api/data", window.location.href);
  const params = {
    latitude: settings.latitude,
    longitude: settings.longitude,
    zoom: settings.zoom,
    width: Math.round(width),
    height: Math.round(height),
    trailMinutes: settings.trailMinutes,
    showRoutes: settings.showRoutes,
    includeGround: settings.includeGround,
    minAltitudeFt: settings.minAltitudeFt,
    basemap: settings.basemap,
    sampleData: settings.sampleData,
    photos: settings.showPhotos ? settings.listCount : 0,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Data route answered ${response.status}`);
  return response.json();
}

// A later INIT (host update or preview edit) can arrive while an earlier
// render is still fetching. Only the newest render may touch the DOM.
let renderSeq = 0;

async function renderPayload(payload) {
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  try {
    markLoading();
    const { messages = {}, language } = await loadLanguageJson(payload, { supported: ["en", "de", "sl"], defaultLanguage: "en" });
    if (stale()) return;
    const locale = language || payload?.meta?.language || "en";
    const settings = normalize(mergeSettings(defaults, getSettings(payload), getQuerySettings()));
    applyColorTheme(settings.color, { defaultTheme: defaults.color });
    const units = unitsFor(settings.units, locale);

    const coords = formatCoords(settings.latitude, settings.longitude);
    // Heading "Flights above <place>" (or the custom title), coordinates below.
    const setPlace = (name) => {
      $("#title").textContent = settings.title || (name ? fill(messages.titlePlace || "Flights above {place}", { place: name }) : messages.title || "Flights overhead");
      $("#place").textContent = coords;
    };
    setPlace(settings.locationName);
    $("#meta").textContent = messages.loading || "Loading …";

    await document.fonts?.ready;
    if (stale()) return;
    const mapWrap = $("#map-wrap");
    const listWrap = $("#list-wrap");
    // Hide the list when no flights are listed, giving the map all the room.
    listWrap.style.display = settings.listCount === 0 ? "none" : "";
    const rect = mapWrap.getBoundingClientRect();
    // Same design unit as --u in render.html.
    const u = 0.52 + Math.min(innerWidth, innerHeight) / 1000;

    let data;
    let fetchError = "";
    try {
      data = await fetchData(settings, rect.width, rect.height);
      if (!data.ok) fetchError = data.error || "error";
    } catch (e) {
      fetchError = e.message || String(e);
    }
    if (stale()) return;

    const flights = data?.flights || [];
    const listed = flights.slice(0, settings.listCount);

    // Header place: the configured label wins, else the nearest town.
    setPlace(settings.locationName || data?.place?.name);

    // Header meta; "+N more" is added once the fit check knows how many rows show.
    const time = formatTime(data?.retrievedAt, locale, settings.timeZone);
    const renderMeta = (moreText = "") =>
      ($("#meta").innerHTML = [
        data?.sample ? `<span><span class="sample-flag">${escapeHtml(messages.sample || "DEMO DATA")}</span></span>` : "",
        `<span><strong>${escapeHtml(fill(messages.inView || "{count} in view", { count: flights.length }))}</strong>${moreText ? ` · ${escapeHtml(moreText)}` : ""}</span>`,
        `<span>${escapeHtml(messages.updated || "Updated")} ${escapeHtml(time)}</span>`,
      ].join(""));
    renderMeta();

    // List
    const list = $("#flights");
    list.innerHTML = listed.map((f, i) => flightRow(f, i + 1, messages, settings.showPhotos)).join("");
    list.classList.toggle("two-col", listed.length > 1);
    // Wait for photos so the frame never captures an empty tile.
    await Promise.all(
      [...list.querySelectorAll("img")].map((img) =>
        Promise.race([img.decode().catch(() => img.closest(".tile")?.classList.add("failed")), new Promise((r) => setTimeout(r, 4000))]),
      ),
    );
    if (stale()) return;
    if (fetchError) {
      list.innerHTML = `<li class="empty"><strong>${escapeHtml(messages.error || "Flight data unavailable")}</strong>${escapeHtml(messages.errorHint || "")}</li>`;
    } else if (!flights.length) {
      list.innerHTML = `<li class="empty"><strong>${escapeHtml(messages.noFlights || "No aircraft in view.")}</strong>${escapeHtml(messages.noFlightsHint || "")}</li>`;
    }

    // Drop rows that do not fit; the map keeps showing every aircraft.
    const rows = () => [...list.querySelectorAll(".flight")];
    let shownRows = rows();
    const overflowing = () => listWrap.scrollHeight > listWrap.clientHeight + 1 || list.scrollHeight > list.clientHeight + 1;
    while (shownRows.length > 1 && overflowing()) {
      shownRows.at(-1).remove();
      shownRows = rows();
    }
    const listedShown = listed.slice(0, shownRows.length || listed.length);
    const more = flights.length - listedShown.length;
    if (more > 0 && listedShown.length) renderMeta(fill(messages.more || "+{count} more", { count: more }));

    // The map may have changed size when rows were removed (portrait).
    const finalRect = mapWrap.getBoundingClientRect();
    if (Math.abs(finalRect.height - rect.height) > 2 || Math.abs(finalRect.width - rect.width) > 2) {
      // Basemap bbox was computed for the first size; refetch only if the map grew noticeably.
      if (finalRect.height > rect.height * 1.08 || finalRect.width > rect.width * 1.08) {
        try {
          data = await fetchData(settings, finalRect.width, finalRect.height);
        } catch {
          /* keep first answer */
        }
        if (stale()) return;
      }
    }

    drawMap({
      svg: $("#map"),
      width: finalRect.width,
      height: finalRect.height,
      data,
      settings,
      listed: listedShown,
      u,
      units,
    });

    mapWrap.querySelector(".map-note")?.remove();
    if (fetchError) {
      mapWrap.insertAdjacentHTML("beforeend", `<div class="map-note error"><strong>${escapeHtml(messages.error || "Flight data unavailable")}</strong></div>`);
    } else if (!flights.length) {
      mapWrap.insertAdjacentHTML("beforeend", `<div class="map-note"><strong>${escapeHtml(messages.noFlights || "No aircraft in view.")}</strong></div>`);
    }

    markReady();
  } catch (error) {
    if (stale()) return;
    console.error(error);
    markError(error);
  }
}

// Render once per page load; the frame's own schedule loads the page again
// for fresh data. A later host message only triggers another render when it
// carries different settings or language (e.g. it arrived after the fallback
// render, or the settings were edited in the preview), never on a timer.
let renderedKey = null;
const payloadKey = (p) => JSON.stringify([getSettings(p), p?.meta?.language ?? null]);
function renderIfChanged(p) {
  const key = payloadKey(p);
  if (key === renderedKey) return;
  renderedKey = key;
  return renderPayload(p);
}

const payload = await waitForPayload({ timeoutMs: 500, onUpdate: renderIfChanged });
await renderIfChanged(payload);
