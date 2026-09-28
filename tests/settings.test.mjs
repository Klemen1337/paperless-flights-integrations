import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, parseBool, parseNumber } from "../assets/settings.js";
import handler from "../api/data.js";

const defaults = {
  title: "",
  locationName: "",
  latitude: 46.0569,
  longitude: 14.5058,
  zoom: 9,
  listCount: 8,
  trailMinutes: 3,
  minAltitudeFt: 0,
  units: "metric",
  basemap: "detailed",
  showRoutes: true,
  includeGround: false,
  showRangeRings: true,
  sampleData: false,
  showPhotos: true,
  timeZone: "Europe/Ljubljana",
};

test("numbers are parsed strictly, with comma decimals", () => {
  assert.equal(parseNumber("46.05"), 46.05);
  assert.equal(parseNumber(" 46,05 "), 46.05);
  assert.equal(parseNumber("-14"), -14);
  for (const bad of ["", " ", "abc", "0x2E", "1e1", "Infinity", "46.0.5", "1,2,3", null, true, [], {}]) {
    assert.ok(Number.isNaN(parseNumber(bad)), `expected NaN for ${JSON.stringify(bad)}`);
  }
});

test("booleans accept common spellings and reject the rest", () => {
  assert.equal(parseBool("TRUE"), true);
  assert.equal(parseBool(" off "), false);
  assert.equal(parseBool(1), true);
  assert.equal(parseBool("maybe"), undefined);
});

test("empty values quietly use defaults, unusable values are flagged", () => {
  const { settings, invalid } = normalizeSettings(
    { latitude: "", longitude: "abc", zoom: "99", units: " Imperial ", showRoutes: "nope", timeZone: "Mars/Base", title: { x: 1 } },
    defaults,
  );
  assert.equal(settings.latitude, 46.0569);
  assert.equal(settings.longitude, 14.5058);
  assert.equal(settings.zoom, 13, "zoom is clamped, not rejected");
  assert.equal(settings.units, "imperial");
  assert.equal(settings.showRoutes, true);
  assert.equal(settings.timeZone, "Europe/Ljubljana");
  assert.equal(settings.title, "");
  assert.deepEqual(invalid.sort(), ["longitude", "showRoutes", "timeZone", "title"]);
});

test("out-of-range coordinates fall back instead of clamping", () => {
  const { settings, invalid } = normalizeSettings({ latitude: "146", longitude: "14,5", listCount: "3.6" }, defaults);
  assert.equal(settings.latitude, 46.0569);
  assert.equal(settings.longitude, 14.5);
  assert.equal(settings.listCount, 4);
  assert.deepEqual(invalid, ["latitude"]);
});

test("data route ignores blank coordinates instead of using 0, 0", async () => {
  const result = await handler({ query: { latitude: "", longitude: " ", sampleData: "true", basemap: "none" } });
  assert.ok(result.flights.length > 0);
  for (const f of result.flights) assert.ok(Math.abs(f.lat - 46) < 3 && Math.abs(f.lon - 14.5) < 3, "demo flights stay near Ljubljana");
});
