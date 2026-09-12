// RoofRadar — polls adsb.lol for aircraft near home, enriches with routes
// from adsbdb, and streams everything to the browser over SSE.
// Zero dependencies: only Node built-ins.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const KM_PER_NM = 1.852;
// Fetch a little wider than the display radius so planes appear at the edge smoothly.
const fetchRadiusNm = Math.min(250, Math.ceil((config.radiusKm + 3) / KM_PER_NM));
// Two community feeds with the same readsb JSON shape; we fail over between them.
const SOURCES = [
  { name: 'adsb.lol', url: `https://api.adsb.lol/v2/point/${config.home.lat}/${config.home.lon}/${fetchRadiusNm}`, key: 'ac' },
  { name: 'adsb.fi', url: `https://opendata.adsb.fi/api/v2/lat/${config.home.lat}/lon/${config.home.lon}/dist/${fetchRadiusNm}`, key: 'aircraft' },
];
let sourceIdx = 0;
let backoffMs = 0;              // extra delay after a 429
const MAX_BACKOFF_MS = 60000;
// Route sources. Both are callsign-based databases and can be stale (airlines
// reuse callsigns); we fetch both and pick the one consistent with the plane's
// observed position/climb, see pickRoute().
const ADSBDB_URL = 'https://api.adsbdb.com/v0/callsign/';
const HEXDB_ROUTE_URL = 'https://hexdb.io/api/v1/route/icao/';
const HEXDB_AIRPORT_URL = 'https://hexdb.io/api/v1/airport/icao/';

// Nearby airports used only to *infer* origin/destination when every route DB
// disagrees with what the aircraft is visibly doing (low + climbing near one).
const LOCAL_AIRPORTS = [
  { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam Airport Schiphol', city: 'Amsterdam', country: 'NL', lat: 52.3086, lon: 4.76389 },
  { icao: 'EHRD', iata: 'RTM', name: 'Rotterdam The Hague Airport', city: 'Rotterdam', country: 'NL', lat: 51.9569, lon: 4.43722 },
  { icao: 'EHEH', iata: 'EIN', name: 'Eindhoven Airport', city: 'Eindhoven', country: 'NL', lat: 51.4501, lon: 5.37453 },
  { icao: 'EHLE', iata: 'LEY', name: 'Lelystad Airport', city: 'Lelystad', country: 'NL', lat: 52.4603, lon: 5.52722 },
];
const INFER_MAX_KM = 40;      // plane must be this close to an airport to infer it
const VALIDATE_MAX_KM = 80;   // a low climbing/descending plane must be within this of its origin/destination
const LOW_ALT_FT = 8000;
const VR_FPM = 300;

// ---------- state ----------
let aircraft = [];            // last normalised snapshot
let lastUpdate = 0;
let lastError = null;
let lastSource = null;
const clients = new Set();    // SSE responses

// ---------- route cache (callsign -> {airline, candidates:[{src,from,to}]}) ----------
const routeCache = new Map(); // callsign -> { data|null, expires }
const airportCache = new Map(); // ICAO -> airport|null
const AIRPORT_TTL_MS = 30 * 24 * 3600 * 1000;
const routeQueue = [];
const queued = new Set();
let routeWorkerRunning = false;
const ROUTE_TTL_MS = 6 * 3600 * 1000;
const ROUTE_NEG_TTL_MS = 30 * 60 * 1000;

function enqueueRoute(callsign) {
  if (!callsign || queued.has(callsign)) return;
  const cached = routeCache.get(callsign);
  if (cached && cached.expires > Date.now()) return;
  queued.add(callsign);
  routeQueue.push(callsign);
  if (!routeWorkerRunning) routeWorker();
}

async function routeWorker() {
  routeWorkerRunning = true;
  while (routeQueue.length) {
    const cs = routeQueue.shift();
    try {
      const data = await lookupRoute(cs);
      routeCache.set(cs, { data, expires: Date.now() + (data ? ROUTE_TTL_MS : ROUTE_NEG_TTL_MS) });
    } catch (e) {
      routeCache.set(cs, { data: null, expires: Date.now() + 5 * 60 * 1000 });
    } finally {
      queued.delete(cs);
    }
    await sleep(350); // be gentle with the route databases
  }
  routeWorkerRunning = false;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'RoofRadar/0.1 (personal, non-commercial)' } });
  if (!res.ok) return null;
  return res.json();
}

async function lookupRoute(cs) {
  const [adsbdb, hexdb] = await Promise.all([
    getJson(ADSBDB_URL + encodeURIComponent(cs)).catch(() => null),
    getJson(HEXDB_ROUTE_URL + encodeURIComponent(cs)).catch(() => null),
  ]);
  const candidates = [];
  let airline = null, iata = null;

  // hexdb: { route: "EHAM-WSSS" } (can be multi-leg "EHAM-DXB-WSSS": take the ends)
  const legs = (hexdb?.route || '').split('-').filter(Boolean);
  if (legs.length >= 2) {
    const [from, to] = await Promise.all([airportByIcao(legs[0]), airportByIcao(legs[legs.length - 1])]);
    if (from || to) candidates.push({ src: 'hexdb', from, to });
  }

  const fr = adsbdb?.response?.flightroute;
  if (fr) {
    airline = fr.airline?.name || null;
    iata = fr.callsign_iata || null;
    candidates.push({ src: 'adsbdb', from: airport(fr.origin), to: airport(fr.destination) });
  }
  return candidates.length ? { airline, iata, candidates } : null;
}

async function airportByIcao(icao) {
  const hit = airportCache.get(icao);
  if (hit && hit.expires > Date.now()) return hit.data;
  const local = LOCAL_AIRPORTS.find((a) => a.icao === icao);
  let data = local ? { ...local } : null;
  if (!data) {
    const j = await getJson(HEXDB_AIRPORT_URL + encodeURIComponent(icao)).catch(() => null);
    if (j?.icao) data = { iata: j.iata || null, icao: j.icao, name: j.airport || null, city: j.region_name || null, country: j.country_code || null, lat: j.latitude, lon: j.longitude };
  }
  airportCache.set(icao, { data, expires: Date.now() + AIRPORT_TTL_MS });
  return data;
}

function airport(a) {
  if (!a) return null;
  return {
    iata: a.iata_code || null,
    icao: a.icao_code || null,
    name: a.name || null,
    city: a.municipality || null,
    country: a.country_iso_name || null,
    lat: a.latitude,
    lon: a.longitude,
  };
}

// Pick the candidate route that agrees with what the plane is doing. A low
// climbing plane must be near its origin; a low descending one near its
// destination. If no candidate fits, infer that end from the nearest local airport.
function pickRoute(entry, ac, altFt, vrFpm) {
  if (!entry) return null;
  const low = altFt != null && altFt < LOW_ALT_FT;
  const climbing = low && vrFpm != null && vrFpm > VR_FPM;
  const descending = low && vrFpm != null && vrFpm < -VR_FPM;
  const near = (ap) => ap?.lat != null && distanceKm(ac.lat, ac.lon, ap.lat, ap.lon) < VALIDATE_MAX_KM;

  let best = null, bestScore = -Infinity;
  for (const c of entry.candidates) {
    let score = c.src === 'hexdb' ? 1 : 0; // tie-break: hexdb has been the fresher DB
    if (climbing) score += near(c.from) ? 10 : -10;
    if (descending) score += near(c.to) ? 10 : -10;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (!best) return null;
  const route = { airline: entry.airline, iata: entry.iata, from: best.from, to: best.to, src: best.src, inferred: null };

  if ((climbing && !near(best.from)) || (descending && !near(best.to))) {
    let nearest = null, nd = INFER_MAX_KM;
    for (const ap of LOCAL_AIRPORTS) {
      const d = distanceKm(ac.lat, ac.lon, ap.lat, ap.lon);
      if (d < nd) { nearest = ap; nd = d; }
    }
    if (nearest) {
      if (climbing) { route.dbFrom = best.from; route.from = { ...nearest }; route.inferred = 'from'; }
      else { route.dbTo = best.to; route.to = { ...nearest }; route.inferred = 'to'; }
    }
  }
  return route;
}

// ---------- geo helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---------- polling ----------
function normalise(ac) {
  if (ac.lat == null || ac.lon == null) return null;
  const callsign = (ac.flight || '').trim();
  const rawAlt = typeof ac.alt_baro === 'number' ? ac.alt_baro : ac.alt_geom ?? null;
  // Feeds sometimes report taxiing aircraft with a numeric (even negative) altitude instead of "ground".
  const onGround = ac.alt_baro === 'ground' || (rawAlt != null && rawAlt <= 50 && (ac.gs ?? 0) < 60);
  const altFt = onGround ? 0 : rawAlt;
  const dist = distanceKm(config.home.lat, config.home.lon, ac.lat, ac.lon);
  if (dist > config.radiusKm) return null;
  const vrFpm = ac.baro_rate ?? ac.geom_rate ?? null;
  const route = callsign ? pickRoute(routeCache.get(callsign)?.data, ac, altFt, vrFpm) : null;
  if (callsign) enqueueRoute(callsign);
  return {
    hex: ac.hex,
    callsign: callsign || null,
    reg: ac.r || null,
    type: ac.t || null,
    desc: ac.desc || null,
    lat: ac.lat,
    lon: ac.lon,
    altFt,
    onGround,
    gsKt: ac.gs ?? null,
    track: ac.track ?? ac.true_heading ?? null,
    vrFpm,
    squawk: ac.squawk || null,
    category: ac.category || null,
    seen: ac.seen ?? null,
    distKm: Math.round(dist * 100) / 100,
    bearing: Math.round(bearingDeg(config.home.lat, config.home.lon, ac.lat, ac.lon)),
    route,
  };
}

async function poll() {
  const src = SOURCES[sourceIdx];
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': 'RoofRadar/0.1 (personal, non-commercial)' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) * 1000;
      backoffMs = Math.min(MAX_BACKOFF_MS, retry || Math.max(config.pollIntervalMs, backoffMs * 2));
      sourceIdx = (sourceIdx + 1) % SOURCES.length; // try the other feed next time
      throw new Error(`${src.name} rate limited (429), backing off ${backoffMs / 1000}s, switching to ${SOURCES[sourceIdx].name}`);
    }
    if (!res.ok) throw new Error(`${src.name} HTTP ${res.status}`);
    const json = await res.json();
    aircraft = (json[src.key] || []).map(normalise).filter(Boolean).sort((a, b) => a.distKm - b.distKm);
    lastUpdate = Date.now();
    lastError = null;
    lastSource = src.name;
    backoffMs = 0;
  } catch (e) {
    lastError = e.message;
    console.error(new Date().toISOString(), 'poll failed:', e.message);
    if (!/429/.test(e.message)) sourceIdx = (sourceIdx + 1) % SOURCES.length;
  }
  broadcast();
  setTimeout(poll, config.pollIntervalMs + backoffMs);
}

function snapshot() {
  return { ts: lastUpdate, error: lastError, source: lastSource, aircraft, config: { home: config.home, radiusKm: config.radiusKm, pollIntervalMs: config.pollIntervalMs } };
}

function broadcast() {
  const payload = `event: update\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: update\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(publicDir, file);
  if (!full.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(config.port, () => {
  console.log(`RoofRadar listening on http://localhost:${config.port}`);
  console.log(`Home: ${config.home.lat}, ${config.home.lon}  radius: ${config.radiusKm} km  sources: ${SOURCES.map((s) => s.name).join(', ')}`);
  poll();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
