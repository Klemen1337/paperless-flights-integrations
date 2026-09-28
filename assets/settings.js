// Settings parsing shared by render.js (browser) and api/data.js (server).
//
// Host settings and query parameters arrive as strings (or anything else), so
// every value is parsed strictly here instead of trusting Number()/Boolean():
// Number("") is 0, which would silently move the map to 0°, 0°.

// Plain decimal numbers only, with "." or "," as the decimal mark (German and
// Slovene users type commas). No hex, exponents, Infinity or empty strings.
const DECIMAL = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const s = value.trim();
  return DECIMAL.test(s) ? Number(s.replace(",", ".")) : NaN;
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

// Returns true/false, or undefined when the value is missing or not a boolean.
export function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return undefined;
}

const isMissing = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// Printable text only: strings and numbers, control characters dropped.
function parseText(value, maxLength) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isTimeZone(name) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

// kind: number (clamped), coord (out of range is invalid, since clamping a
// coordinate just moves the map somewhere wrong), integer, bool, choice, text,
// timeZone.
export const SETTINGS = {
  title: { kind: "text", maxLength: 60 },
  locationName: { kind: "text", maxLength: 60 },
  latitude: { kind: "coord", min: -85, max: 85 },
  longitude: { kind: "coord", min: -180, max: 180 },
  zoom: { kind: "number", min: 5, max: 13 },
  listCount: { kind: "integer", min: 0, max: 12 },
  trailMinutes: { kind: "integer", min: 0, max: 15 },
  minAltitudeFt: { kind: "integer", min: 0, max: 40000 },
  units: { kind: "choice", choices: ["aviation", "metric", "imperial"] },
  basemap: { kind: "choice", choices: ["detailed", "simple", "none"] },
  showRoutes: { kind: "bool" },
  includeGround: { kind: "bool" },
  showRangeRings: { kind: "bool" },
  sampleData: { kind: "bool" },
  showPhotos: { kind: "bool" },
  timeZone: { kind: "timeZone" },
};

// Parses one value. Returns { value, invalid }: a missing value quietly takes
// the fallback, a present but unusable one takes it and is flagged invalid.
export function readSetting(key, raw, fallback) {
  const spec = SETTINGS[key];
  if (!spec || isMissing(raw)) return { value: fallback, invalid: false };
  const bad = { value: fallback, invalid: true };
  switch (spec.kind) {
    case "number":
    case "integer":
    case "coord": {
      let n = parseNumber(raw);
      if (Number.isNaN(n)) return bad;
      if (spec.kind === "coord" && (n < spec.min || n > spec.max)) return bad;
      if (spec.kind === "integer") n = Math.round(n);
      return { value: Math.min(spec.max, Math.max(spec.min, n)), invalid: false };
    }
    case "bool": {
      const b = parseBool(raw);
      return b === undefined ? bad : { value: b, invalid: false };
    }
    case "choice": {
      const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return spec.choices.includes(s) ? { value: s, invalid: false } : bad;
    }
    case "text": {
      const s = parseText(raw, spec.maxLength);
      return s === undefined ? bad : { value: s, invalid: false };
    }
    case "timeZone": {
      const s = typeof raw === "string" ? raw.trim() : "";
      return s && isTimeZone(s) ? { value: s, invalid: false } : bad;
    }
    default:
      return { value: fallback, invalid: false };
  }
}

// Parses every known setting; unknown keys (e.g. the global color, which the
// toolkit validates itself) pass through unchanged. `invalid` lists the keys
// that were set to something unusable and fell back to their default.
export function normalizeSettings(raw, defaults) {
  const settings = { ...raw };
  const invalid = [];
  for (const key of Object.keys(SETTINGS)) {
    const { value, invalid: bad } = readSetting(key, raw?.[key], defaults[key]);
    settings[key] = value;
    if (bad) invalid.push(key);
  }
  return { settings, invalid };
}
