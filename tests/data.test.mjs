import test from "node:test";
import assert from "node:assert/strict";
import { createProjection, distanceKm, destination } from "../assets/geo.js";
import handler from "../api/data.js";

test("projection puts the centre in the middle and covers a similar area on both panel sizes", () => {
  const small = createProjection({ latitude: 46, longitude: 14.5, zoom: 9, width: 480, height: 420 });
  const large = createProjection({ latitude: 46, longitude: 14.5, zoom: 9, width: 1200, height: 1050 });
  const [x, y] = small.project([14.5, 46]);
  assert.ok(Math.abs(x - 240) < 1e-6 && Math.abs(y - 210) < 1e-6);
  const spanSmall = small.bbox.east - small.bbox.west;
  const spanLarge = large.bbox.east - large.bbox.west;
  assert.ok(Math.abs(spanSmall - spanLarge) / spanSmall < 0.01);
});

test("destination and distance agree", () => {
  const [lat, lon] = destination(46, 14.5, 60, 25);
  assert.ok(Math.abs(distanceKm(46, 14.5, lat, lon) - 25) < 0.01);
});

test("demo mode returns sorted flights with trails and a basemap", async () => {
  const r = await handler({ query: { sampleData: "true", width: "600", height: "600", zoom: "9" } });
  assert.equal(r.ok, true);
  assert.equal(r.source, "demo");
  assert.ok(r.flights.length >= 5);
  for (let i = 1; i < r.flights.length; i += 1) assert.ok(r.flights[i - 1].distanceKm <= r.flights[i].distanceKm);
  assert.ok(r.flights.every((f) => f.trail.length > 1));
  assert.ok(r.basemap.places.some((p) => p.n === "Ljubljana"));
});

test("live mode parses adsb.lol positions, traces and routes", async () => {
  const realFetch = globalThis.fetch;
  const nowSec = Date.now() / 1000;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).includes("/v2/point/")) {
      return json({
        now: Date.now(),
        ac: [
          { hex: "4690e4", flight: "AEE3NC  ", r: "SX-DGD", t: "A320", alt_baro: 37000, gs: 465, track: 134, baro_rate: 0, lat: 46.1, lon: 14.6, seen_pos: 0.2, category: "A3" },
          { hex: "abc123", flight: "GND1", alt_baro: "ground", gs: 5, track: 10, lat: 46.2, lon: 14.45, seen_pos: 1 },
          { hex: "def456", flight: "STALE", alt_baro: 20000, lat: 46.0, lon: 14.4, seen_pos: 300 },
        ],
      });
    }
    if (String(url).includes("trace_recent_4690e4")) {
      return json({ timestamp: nowSec - 100, trace: [[0, 46.2, 14.4, 37000, 460, 134], [50, 46.15, 14.5, 37000, 460, 134], [-900, 40, 10, 1, 1, 1]] });
    }
    if (String(url).includes("routeset")) {
      assert.equal(opts.method, "POST");
      return json([{ callsign: "AEE3NC", _airport_codes_iata: "ATH-FRA", _airports: [{ iata: "ATH", location: "Athens" }, { iata: "FRA", location: "Frankfurt" }], plausible: 1 }]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const r = await handler({ query: { width: "600", height: "600", zoom: "8", trailMinutes: "5" } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, "adsb.lol");
    assert.equal(r.flights.length, 1, "ground and stale aircraft are dropped");
    const f = r.flights[0];
    assert.equal(f.callsign, "AEE3NC");
    assert.equal(f.route.from, "ATH");
    assert.equal(f.route.toName, "Frankfurt");
    assert.equal(f.trail.length, 3, "two recent trace points plus the current position");
    assert.deepEqual(f.trail.at(-1), [14.6, 46.1]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("upstream failure is reported, basemap still returned", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const r = await handler({ query: { latitude: "48.2", longitude: "16.37", width: "500", height: "500" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /No flight source reachable/);
    assert.ok(r.basemap && r.basemap.places.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
