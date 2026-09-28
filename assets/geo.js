// Shared map math for the render page and the API route.
// Web Mercator, with the zoom level normalised to the shorter side of the map
// so the same zoom shows a similar area on the 7" and L displays.

export const CELL_DEG = 2;
export const REFERENCE_SIDE = 480;
export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_NM = 1.852;

export function cellKey(latIndex, lonIndex) {
  return `${latIndex}_${lonIndex}`;
}

const clampLat = (lat) => Math.max(-85.05, Math.min(85.05, lat));

export function worldSize(zoom, width, height) {
  const scale = Math.min(width, height) / REFERENCE_SIDE;
  return 256 * 2 ** zoom * scale;
}

function mercX(lon) {
  return (lon + 180) / 360;
}
function mercY(lat) {
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
function invMercX(x) {
  return x * 360 - 180;
}
function invMercY(y) {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Creates a projector for a map of `width` x `height` px centred on lat/lon.
 * `project([lon, lat])` returns [x, y] in px.
 */
export function createProjection({ latitude, longitude, zoom, width, height }) {
  const size = worldSize(zoom, width, height);
  const cx = mercX(longitude) * size;
  const cy = mercY(latitude) * size;
  const project = ([lon, lat]) => [mercX(lon) * size - cx + width / 2, mercY(lat) * size - cy + height / 2];
  const unproject = ([x, y]) => [invMercX((x - width / 2 + cx) / size), invMercY((y - height / 2 + cy) / size)];
  const [west, north] = unproject([0, 0]);
  const [east, south] = unproject([width, height]);
  // Pixels per km at the centre latitude.
  const pxPerKm = size / (2 * Math.PI * EARTH_RADIUS_KM * Math.cos((latitude * Math.PI) / 180));
  return { project, unproject, bbox: { west, south, east, north }, pxPerKm, width, height };
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Moves a point `km` along `bearing` degrees. Returns [lat, lon]. */
export function destination(lat, lon, bearing, km) {
  const toRad = Math.PI / 180;
  const d = km / EARTH_RADIUS_KM;
  const b = bearing * toRad;
  const la1 = lat * toRad;
  const lo1 = lon * toRad;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 / toRad, (((lo2 / toRad + 540) % 360) - 180)];
}

export function compassPoint(deg) {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
