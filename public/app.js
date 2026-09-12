// RoofRadar frontend: Leaflet map + SSE feed from server.js

const KT_TO_KMH = 1.852;
const FT_TO_M = 0.3048;
const state = { config: null, planes: new Map(), selected: null, lastTs: 0, hideGround: true, lastList: [] };

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true });
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
  L.circle([home.lat, home.lon], { radius: state.config.radiusKm * 1000, color: '#4fc3f7', weight: 1, dashArray: '6 6', fill: false }).addTo(layers.house);
  for (const r of [5, 10, 20]) {
    if (r < state.config.radiusKm) L.circle([home.lat, home.lon], { radius: r * 1000, color: '#4fc3f7', weight: 1, opacity: 0.35, dashArray: '2 6', fill: false }).addTo(layers.house);
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
  document.getElementById('status').title = data.error || `live via ${data.source}`;

  const seen = new Set();
  state.lastList = data.aircraft;
  const visible = data.aircraft.filter((ac) => !(state.hideGround && ac.onGround));
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
  drawRoute(state.planes.get(state.selected));
}

function labelFor(ac) {
  const alt = ac.onGround ? 'GND' : `${Math.round(ac.altFt * FT_TO_M)} m`;
  return `${ac.callsign || ac.reg || ac.hex} · ${alt}`;
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
    .bindTooltip(`${label} ${ap.iata || ap.icao} · ${ap.name || ''}`, { permanent: true, direction: 'top', offset: [0, -8], className: 'plane-label' });
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
  return `<b title="${esc(a.name || '')}">${code}</b> <span class="muted">${esc(a.city || '')}</span>${tag}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function compass(b) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; }
function vrHtml(vr) {
  if (vr == null) return '–';
  if (Math.abs(vr) < 64) return 'level';
  const ms = (vr * FT_TO_M / 60).toFixed(1);
  return vr > 0 ? `<span class="vr-up">▲${ms} m/s</span>` : `<span class="vr-down">▼${Math.abs(ms)} m/s</span>`;
}

function renderList(list) {
  const el = document.getElementById('list');
  el.innerHTML = list.map((ac) => {
    const r = ac.route;
    return `<div class="flight ${state.selected === ac.hex ? 'selected' : ''}" data-hex="${ac.hex}">
      <div class="row1">
        <div><span class="cs">${esc(ac.callsign || ac.reg || ac.hex)}</span> <span class="airline">${esc(r?.airline || '')}</span></div>
        <div class="dist">${ac.distKm.toFixed(1)} km ${compass(ac.bearing)}</div>
      </div>
      <div class="route">${fmtAirport(r?.from, r?.inferred === 'from' ? r.dbFrom : undefined)}<span class="arrow">→</span>${fmtAirport(r?.to, r?.inferred === 'to' ? r.dbTo : undefined)}${r ? ' <a class="fit" data-fit="' + ac.hex + '" href="#">fit route</a>' : ''}</div>
      <div class="grid">
        <div>Alt <b>${ac.onGround ? 'ground' : Math.round(ac.altFt * FT_TO_M) + ' m'}</b></div>
        <div>Speed <b>${ac.gsKt != null ? Math.round(ac.gsKt * KT_TO_KMH) + ' km/h' : '–'}</b></div>
        <div>Heading <b>${ac.track != null ? Math.round(ac.track) + '° ' + compass(ac.track) : '–'}</b></div>
        <div>Climb <b>${vrHtml(ac.vrFpm)}</b></div>
        <div>Squawk <b>${ac.squawk || '–'}</b></div>
        <div>Reg <b>${esc(ac.reg || '–')}</b></div>
      </div>
      <div class="type">${esc(ac.type || '')} ${esc(ac.desc || '')}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.flight').forEach((n) => n.addEventListener('click', () => select(n.dataset.hex, true)));
  el.querySelectorAll('.fit').forEach((n) => n.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (state.selected !== n.dataset.fit) select(n.dataset.fit, false);
    fitRoute(n.dataset.fit);
  }));
}

function select(hex, pan) {
  state.selected = state.selected === hex ? null : hex;
  for (const [h, p] of state.planes) p.marker.setIcon(planeIcon(p.data, h === state.selected));
  document.querySelectorAll('.flight').forEach((n) => n.classList.toggle('selected', n.dataset.hex === state.selected));
  const p = state.planes.get(state.selected);
  drawRoute(p);
  if (pan && p) map.panTo(p.marker.getLatLng());
}

// ---------- init ----------
function initFromConfig() {
  const { home, radiusKm } = state.config;
  document.getElementById('home-name').textContent = `${home.name} · ${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`;
  document.getElementById('stat-radius').textContent = radiusKm;
  drawHouse(home);
  map.fitBounds(L.latLng(home.lat, home.lon).toBounds(radiusKm * 2000), { padding: [10, 10] });
  document.getElementById('zoom-home').onclick = () => map.setView([home.lat, home.lon], 17);
  document.getElementById('zoom-all').onclick = () => map.fitBounds(L.latLng(home.lat, home.lon).toBounds(radiusKm * 2000), { padding: [10, 10] });
  requestAnimationFrame(animate);
}

document.getElementById('hide-ground').addEventListener('change', (e) => {
  state.hideGround = e.target.checked;
  applyUpdate({ ts: state.lastTs, error: null, aircraft: state.lastList, config: state.config });
});

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
