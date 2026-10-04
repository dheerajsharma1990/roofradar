// RoofRadar frontend: Leaflet map + SSE feed from server.js

const KT_TO_KMH = 1.852;
const FT_TO_M = 0.3048;
const state = { config: null, planes: new Map(), selected: null, lastTs: 0, altBand: 'all', lastList: [] };
// What you can see from the house: azimuth sector + elevation band (degrees
// above the horizon) + max distance. This is the only filter; the map zoom isn't.
const WIN_KEY = 'roofradar.window';
// Width/elevation/distance reset to these on every load; only the direction
// the window faces (fixed for a given house) is remembered.
const WIN_DEFAULTS = {
  fov: 150,    // close to the glass you can look from one end of the window to the other
  minEl: 3,    // low enough to catch Schiphol take-offs and landings a few km out
  maxEl: 80,   // tilting your head back at the glass; 90° would be straight overhead
  maxKm: 100,  // past this a jet is a dot in the haze; at 5° up it is ~120 km out anyway
};
const win = { az: 180, ...WIN_DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(WIN_KEY)) || {};
  if (Number.isFinite(saved.az)) win.az = saved.az;
} catch {}
function saveWin() { try { localStorage.setItem(WIN_KEY, JSON.stringify({ az: win.az })); } catch {} }
const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(iso) {
  if (!iso) return '';
  try { return regionNames?.of(iso.toUpperCase()) || iso; } catch { return iso; }
}

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true, zoomSnap: 0.1, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'dark-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · data <a href="https://adsb.lol">adsb.lol</a> · routes <a href="https://adsbdb.com">adsbdb</a>',
}).addTo(map);

const layers = {
  house: L.layerGroup().addTo(map),
  trails: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  planes: L.layerGroup().addTo(map),
};

// ---------- house marker + range rings ----------
function metersToLatLng(lat, lon, dxEast, dyNorth) {
  const dLat = dyNorth / 111320;
  const dLon = dxEast / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}
function drawHouse(home) {
  layers.house.clearLayers();
  L.marker([home.lat, home.lon], {
    icon: L.divIcon({ className: 'house-marker', html: '🏠', iconSize: [26, 26], iconAnchor: [13, 13] }),
    interactive: false,
  }).bindTooltip(home.name, { direction: 'top', offset: [0, -12], className: 'plane-label' }).addTo(layers.house);
  // faint distance rings for scale
  for (const r of [5, 10, 25, 50, 100]) {
    L.circle([home.lat, home.lon], { radius: r * 1000, color: '#4fc3f7', weight: 1, opacity: 0.3, dashArray: '2 6', fill: false, interactive: false }).addTo(layers.house);
  }
}

// ---------- plane icon ----------
const PLANE_PATH = 'M12 2c-.6 0-1 .5-1 1.2V9L3 13.5v2l8-2.2v4.3l-2 1.5V20l3-1 3 1v-1l-2-1.5v-4.3l8 2.2v-2L13 9V3.2c0-.7-.4-1.2-1-1.2z';
function altColor(altFt, onGround) {
  if (onGround) return '#9e9e9e';
  if (altFt < 2000) return '#ef5350';
  if (altFt < 5000) return '#ffb74d';
  if (altFt < 10000) return '#ffee58';
  if (altFt < 20000) return '#66bb6a';
  return '#4fc3f7';
}
function planeIcon(p, selected) {
  const size = p.onGround ? 18 : 30;
  return L.divIcon({
    className: '',
    html: `<div class="plane-icon ${selected ? 'selected' : ''}" style="transform:rotate(${p.track ?? 0}deg)">
      <svg viewBox="0 0 24 24"><path d="${PLANE_PATH}" fill="${altColor(p.altFt, p.onGround)}"/></svg></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ---------- update from server ----------
function applyUpdate(data) {
  if (!state.config) {
    state.config = data.config;
    initFromConfig();
  }
  state.lastTs = data.ts;
  document.getElementById('status').className = 'stat status ' + (data.error ? 'bad' : 'ok');
  if (data.source !== 'view') document.getElementById('status').title = data.error || `live via ${data.source}`;

  const seen = new Set();
  state.lastList = data.aircraft;
  // ground traffic is never visible from the house, so it is always left out
  const visible = data.aircraft.filter((ac) => !ac.onGround && inAltBand(ac) && inView(ac));
  visible.sort((a, b) => b.elevDeg - a.elevDeg); // highest in the sky (easiest to spot) first
  for (const ac of visible) {
    seen.add(ac.hex);
    let p = state.planes.get(ac.hex);
    if (!p) {
      p = { data: ac, marker: null, trail: [], trailLine: null, drLat: ac.lat, drLon: ac.lon, drTs: performance.now() };
      p.marker = L.marker([ac.lat, ac.lon], { icon: planeIcon(ac, false) })
        .bindTooltip(labelFor(ac), { permanent: true, direction: 'right', offset: [14, 0], className: 'plane-label' })
        .on('click', () => select(ac.hex))
        .addTo(layers.planes);
      state.planes.set(ac.hex, p);
    } else {
      p.data = ac;
      p.marker.setIcon(planeIcon(ac, state.selected === ac.hex));
      p.marker.setTooltipContent(labelFor(ac));
    }
    // reset dead reckoning to the real position
    p.drLat = ac.lat; p.drLon = ac.lon; p.drTs = performance.now();
    const last = p.trail[p.trail.length - 1];
    if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
      p.trail.push([ac.lat, ac.lon]);
      if (p.trail.length > 60) p.trail.shift();
    }
    if (!p.trailLine) p.trailLine = L.polyline(p.trail, { color: altColor(ac.altFt, ac.onGround), weight: 1.5, opacity: 0.5 }).addTo(layers.trails);
    else p.trailLine.setLatLngs(p.trail).setStyle({ color: altColor(ac.altFt, ac.onGround) });
  }
  for (const [hex, p] of state.planes) {
    if (!seen.has(hex)) {
      layers.planes.removeLayer(p.marker);
      if (p.trailLine) layers.trails.removeLayer(p.trailLine);
      state.planes.delete(hex);
      if (state.selected === hex) state.selected = null;
    }
  }
  document.getElementById('stat-count').textContent = visible.length;
  renderList(visible);
  renderInfo();
  drawRoute(state.planes.get(state.selected));
}

// altitude bands (in km above sea level): low < 5 is take-off/landing traffic, high is en route
const ALT_BANDS = { all: [-Infinity, Infinity], low: [-Infinity, 5], high: [5, Infinity] };
function inAltBand(ac) {
  const [lo, hi] = ALT_BANDS[state.altBand] || ALT_BANDS.all;
  const km = (ac.altFt ?? 0) * FT_TO_M / 1000;
  return km >= lo && km < hi;
}

// signed difference b - a in degrees, in (-180, 180]
function angDiff(a, b) { return ((b - a + 540) % 360) - 180; }
function inView(ac) {
  return ac.elevDeg != null && ac.distKm <= win.maxKm && ac.elevDeg >= win.minEl && ac.elevDeg <= win.maxEl
    && Math.abs(angDiff(win.az, ac.bearing)) <= win.fov / 2;
}
// where to look relative to the centre of the window, e.g. "12° up · 20° left"
function lookHtml(ac) {
  if (win.fov >= 360) return `${Math.round(ac.elevDeg)}° up · ${compass(ac.bearing)}`;
  const off = Math.round(angDiff(win.az, ac.bearing));
  const side = Math.abs(off) < 3 ? 'ahead' : `${Math.abs(off)}° ${off < 0 ? 'left' : 'right'}`;
  return `${Math.round(ac.elevDeg)}° up · ${side}`;
}

// short map label: callsign + how high to look; altitude is in the icon colour and the card
function labelFor(ac) {
  const el = ac.elevDeg != null ? ` ${Math.round(ac.elevDeg)}°` : '';
  return `${ac.callsign || ac.reg || ac.hex}${el}`;
}

// ---------- dead reckoning between polls (smooth motion) ----------
function animate() {
  const now = performance.now();
  for (const p of state.planes.values()) {
    const d = p.data;
    if (d.onGround || d.gsKt == null || d.track == null) continue;
    const dt = (now - p.drTs) / 1000;
    if (dt > 15) continue; // stale, stop extrapolating
    const distM = d.gsKt * KT_TO_KMH * 1000 / 3600 * dt;
    const th = (d.track * Math.PI) / 180;
    const [lat, lon] = metersToLatLng(p.drLat, p.drLon, distM * Math.sin(th), distM * Math.cos(th));
    p.marker.setLatLng([lat, lon]);
  }
  requestAnimationFrame(animate);
}

// ---------- route line (origin -> plane -> destination) ----------
function greatCircle(a, b, n = 64) {
  // intermediate points along the great circle between two [lat, lon] pairs
  const toR = (d) => (d * Math.PI) / 180, toD = (r) => (r * 180) / Math.PI;
  const [lat1, lon1, lat2, lon2] = [toR(a[0]), toR(a[1]), toR(b[0]), toR(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d < 1e-9) return [a, b];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([toD(Math.atan2(z, Math.sqrt(x * x + y * y))), toD(Math.atan2(y, x))]);
  }
  return pts;
}
function airportMarker(ap, label) {
  return L.circleMarker([ap.lat, ap.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#4fc3f7', fillOpacity: 1 })
    .bindTooltip(`${label} ${ap.iata || ap.icao} · ${ap.name || ''}${ap.country ? ' · ' + countryName(ap.country) : ''}`, { permanent: true, direction: 'top', offset: [0, -8], className: 'plane-label' });
}
function drawRoute(p) {
  layers.route.clearLayers();
  if (!p) return;
  const { route, lat, lon } = p.data;
  if (!route) return;
  const here = [lat, lon];
  if (route.from?.lat != null) {
    L.polyline(greatCircle([route.from.lat, route.from.lon], here), { color: '#4fc3f7', weight: 2.5, opacity: 0.9 }).addTo(layers.route);
    airportMarker(route.from, 'From').addTo(layers.route);
  }
  if (route.to?.lat != null) {
    L.polyline(greatCircle(here, [route.to.lat, route.to.lon]), { color: '#4fc3f7', weight: 2.5, opacity: 0.9, dashArray: '8 8' }).addTo(layers.route);
    airportMarker(route.to, 'To').addTo(layers.route);
  }
}
function fitRoute(hex) {
  const p = state.planes.get(hex);
  if (!p?.data.route) return;
  const pts = [[p.data.lat, p.data.lon]];
  for (const ap of [p.data.route.from, p.data.route.to]) if (ap?.lat != null) pts.push([ap.lat, ap.lon]);
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

// ---------- side panel ----------
function fmtAirport(a, inferredFrom) {
  if (!a) return '<span class="unknown">unknown</span>';
  const code = a.iata || a.icao || '?';
  let tag = '';
  if (inferredFrom !== undefined) {
    const db = inferredFrom ? (inferredFrom.iata || inferredFrom.icao) : '?';
    tag = ` <span class="inferred" title="Inferred from the aircraft's position — route database said ${esc(db)}">≈</span>`;
  }
  const place = [a.city, countryName(a.country)].filter(Boolean).join(', ');
  return `<b title="${esc(a.name || '')}">${code}</b> <span class="muted">${esc(place)}</span>${tag}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function compass(b) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; }
function vrHtml(vr) {
  if (vr == null) return '–';
  if (Math.abs(vr) < 64) return 'level';
  const ms = (vr * FT_TO_M / 60).toFixed(1);
  return vr > 0 ? `<span class="vr-up">▲${ms} m/s</span>` : `<span class="vr-down">▼${Math.abs(ms)} m/s</span>`;
}

function flightHtml(ac, extra = '') {
    const r = ac.route;
    return `<div class="flight ${state.selected === ac.hex ? 'selected' : ''}" data-hex="${ac.hex}">${extra}
      <div class="row1">
        <div><span class="cs">${esc(ac.callsign || ac.reg || ac.hex)}</span> <span class="airline">${esc(r?.airline || '')}</span></div>
        <div class="dist">${lookHtml(ac)}</div>
      </div>
      <div class="route">${fmtAirport(r?.from, r?.inferred === 'from' ? r.dbFrom : undefined)}<span class="arrow">→</span>${fmtAirport(r?.to, r?.inferred === 'to' ? r.dbTo : undefined)}${r ? ' <a class="fit" data-fit="' + ac.hex + '" href="#">fit route</a>' : ''}</div>
      <div class="grid">
        <div>Alt <b>${ac.onGround ? 'ground' : Math.round(ac.altFt * FT_TO_M) + ' m'}</b></div>
        <div>Speed <b>${ac.gsKt != null ? Math.round(ac.gsKt * KT_TO_KMH) + ' km/h' : '–'}</b></div>
        <div>Heading <b>${ac.track != null ? Math.round(ac.track) + '° ' + compass(ac.track) : '–'}</b></div>
        <div>Climb <b>${vrHtml(ac.vrFpm)}</b></div>
        <div>Dist <b>${ac.distKm < 10 ? ac.distKm.toFixed(1) : Math.round(ac.distKm)} km ${compass(ac.bearing)}</b></div>
        <div>Reg <b>${esc(ac.reg || '–')}</b></div>
      </div>
      <div class="type">${esc(ac.type || '')} ${esc(ac.desc || '')}</div>
    </div>`;
}
function bindFit(el) {
  el.querySelectorAll('.fit').forEach((n) => n.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (state.selected !== n.dataset.fit) select(n.dataset.fit, false);
    fitRoute(n.dataset.fit);
  }));
}

function renderList(list) {
  const el = document.getElementById('list');
  el.innerHTML = list.map((ac) => flightHtml(ac)).join('');
  el.querySelectorAll('.flight').forEach((n) => n.addEventListener('click', () => select(n.dataset.hex, true)));
  bindFit(el);
}

// floating card over the map for the selected plane, so a tap on a marker shows its details right away
function renderInfo() {
  const el = document.getElementById('info');
  const p = state.planes.get(state.selected);
  el.hidden = !p;
  if (!p) { el.innerHTML = ''; return; }
  el.innerHTML = flightHtml(p.data, '<button class="close" aria-label="Close">×</button>');
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); select(state.selected); });
  bindFit(el);
}

// ---------- window view ----------
let sector = null;
function bearingTo(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function sectorPoints() {
  const { home } = state.config;
  const pts = win.fov >= 360 ? [] : [[home.lat, home.lon]]; // all around is a plain circle
  const steps = Math.max(8, Math.round(win.fov / 3));
  for (let i = 0; i <= steps; i++) {
    const th = ((win.az - win.fov / 2 + (win.fov * i) / steps) * Math.PI) / 180;
    pts.push(metersToLatLng(home.lat, home.lon, win.maxKm * 1000 * Math.sin(th), win.maxKm * 1000 * Math.cos(th)));
  }
  return pts;
}
function drawSector() {
  if (sector) { layers.house.removeLayer(sector); sector = null; }
  sector = L.polygon(sectorPoints(), { color: '#ffb74d', weight: 1.5, opacity: 0.8, fillColor: '#ffb74d', fillOpacity: 0.06, interactive: false }).addTo(layers.house);
}
function fitSector() { map.fitBounds(L.latLngBounds(sectorPoints()), { padding: [20, 20] }); }
function refresh() { applyUpdate({ ts: state.lastTs, error: null, source: 'view', aircraft: state.lastList, config: state.config }); }

const WIN_SLIDERS = {
  az: ['w-az', (v) => `${v}° ${compass(v)}`],
  fov: ['w-fov', (v) => (v >= 360 ? 'all around' : `${v}°`)],
  minEl: ['w-min', (v) => `${v}° up`],
  maxEl: ['w-max', (v) => `${v}° up`],
  maxKm: ['w-dist', (v) => `${v} km`],
};
function syncWinControls() {
  for (const [key, [id, fmt]] of Object.entries(WIN_SLIDERS)) {
    document.getElementById(id).value = win[key];
    document.getElementById(id + '-out').textContent = fmt(win[key]);
  }
  const dir = win.fov >= 360 ? 'all around' : `${compass(win.az)} ${win.az}° · ${win.fov}° wide`;
  document.getElementById('w-summary').textContent = `${dir} · ${win.minEl}–${win.maxEl}° up · ${win.maxKm} km`;
}
function initWindow() {
  const sky = state.config.skyRadiusKm || state.config.radiusKm;
  document.getElementById('w-dist').max = sky;
  win.maxKm = Math.min(win.maxKm, sky);
  syncWinControls();
  for (const [key, [id]] of Object.entries(WIN_SLIDERS)) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      win[key] = Number(el.value);
      // keep the elevation band valid
      if (key === 'minEl' && win.minEl >= win.maxEl) win.maxEl = Math.min(90, win.minEl + 1);
      if (key === 'maxEl' && win.maxEl <= win.minEl) win.minEl = Math.max(0, win.maxEl - 1);
      syncWinControls(); saveWin(); drawSector(); refresh();
    });
    if (key === 'az' || key === 'maxKm' || key === 'fov') el.addEventListener('change', fitSector);
  }
  const aim = document.getElementById('w-aim');
  let aiming = false;
  const setAiming = (on) => { aiming = on; aim.classList.toggle('aiming', on); map.getContainer().classList.toggle('aim', on); aim.textContent = on ? 'Now tap the map…' : 'Aim: tap the map where your window looks'; };
  aim.addEventListener('click', () => setAiming(!aiming));
  map.on('click', (e) => {
    if (!aiming) { if (state.selected) select(state.selected); return; } // tap empty map closes the card
    const { home } = state.config;
    win.az = Math.round(bearingTo(home.lat, home.lon, e.latlng.lat, e.latlng.lng)) % 360;
    setAiming(false); syncWinControls(); saveWin(); drawSector(); refresh(); fitSector();
  });
}

function select(hex, pan) {
  state.selected = state.selected === hex ? null : hex;
  for (const [h, p] of state.planes) p.marker.setIcon(planeIcon(p.data, h === state.selected));
  document.querySelectorAll('.flight').forEach((n) => n.classList.toggle('selected', n.dataset.hex === state.selected));
  const p = state.planes.get(state.selected);
  drawRoute(p);
  renderInfo();
  if (pan && p) map.panTo(p.marker.getLatLng());
}

// ---------- init ----------
function initFromConfig() {
  const { home } = state.config;
  document.getElementById('home-name').textContent = `${home.name} · ${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`;
  drawHouse(home);
  initWindow();
  drawSector();
  fitSector();
  // map button to get back to the whole view after panning/zooming around
  const FitControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', 'fit-ctl', box);
      a.href = '#'; a.title = 'Show my whole view'; a.setAttribute('role', 'button'); a.textContent = '⌂';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); fitSector(); });
      return box;
    },
  });
  map.addControl(new FitControl());
  requestAnimationFrame(animate);
}

document.querySelectorAll('#alt-filter button').forEach((b) => b.addEventListener('click', () => {
  state.altBand = b.dataset.band;
  document.querySelectorAll('#alt-filter button').forEach((n) => n.classList.toggle('active', n === b));
  refresh();
}));

setInterval(() => {
  const age = state.lastTs ? Math.round((Date.now() - state.lastTs) / 1000) : null;
  document.getElementById('stat-age').textContent = age == null ? '–' : `${age}s`;
}, 1000);

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('update', (e) => applyUpdate(JSON.parse(e.data)));
  es.onerror = () => { document.getElementById('status').className = 'stat status bad'; };
}
connect();
