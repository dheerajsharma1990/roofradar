# RoofRadar 🛩️

Real-time map of every aircraft flying within a configurable radius of your house,
with route (from → to), altitude, speed, heading and climb rate.

- Live positions from [adsb.lol](https://adsb.lol) with automatic failover to [adsb.fi](https://adsb.fi) (free community ADS-B feeds); 429s trigger exponential backoff
- Routes from [hexdb.io](https://hexdb.io) and [adsbdb](https://www.adsbdb.com), airlines from adsbdb (cached per callsign)
- Zero npm dependencies — Node 18+ built-ins only, Leaflet from CDN in the browser
- Smooth motion between polls via dead reckoning, altitude-coloured icons, trails
- **One view: what you can see from home.** Set the direction your window faces (slider, or tap a landmark on the map), how wide it is (360° = all around), the lowest/highest angle above the horizon you can see, and how far. Only aircraft inside that cone are shown, highest in the sky first, each with where to look ("12° up · 20° left"). Elevation accounts for earth curvature and refraction. Width, angles and distance reset to 150°, 3–80° and 100 km on every load; the facing direction is remembered per browser. Ground traffic is always hidden.
- **All / Low / High**: everything in view, low traffic under 5 km (take-off & landing), or high traffic crossing over. Map zoom never filters; ⌂ on the map jumps back to the whole view.
- Click a flight → great-circle route line origin → plane → destination ("fit route" zooms to it)

## Run

```bash
node server.js
# open http://localhost:8420  (or http://<lan-ip>:8420 from another device)
```

Runs at boot as a systemd service (`roofradar.service`, see `roofradar.service` in this folder):

```bash
sudo cp roofradar.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now roofradar
systemctl status roofradar      # state
journalctl -u roofradar -f      # logs
sudo systemctl restart roofradar  # after editing config.json
```

If you run a host firewall, open the port for your LAN only.

## Configure

```bash
cp config.example.json config.json   # then edit
```

`config.json` is gitignored so your home coordinates never end up in the repo. Keys:

| key | meaning |
|---|---|
| `home.lat`, `home.lon` | your house coordinates |
| `radiusKm` | the server tracks everything within this, even below the horizon (default 30) |
| `skyRadiusKm` | optional, default 150: beyond `radiusKm` the server keeps tracking aircraft out to this distance, but only those above the horizon, for window view |
| `home.heightM` | optional, default 10: your eye height above ground at the window, used for elevation angles |
| `pollIntervalMs` | how often to ask adsb.lol (keep ≥ 2000) |
| `port` | HTTP port |

## Notes

- adsb.lol, adsb.fi and adsbdb are free for personal, non-commercial use. adsb.lol rate-limits bursts from one IP; the poller backs off and switches feed automatically (hover the status dot to see which feed is live).
- Routes are looked up by callsign and the databases can be stale (SIA333 is AMS→SIN in hexdb but CDG→SIN in adsbdb). The server asks both and picks the one consistent with the aircraft: a low, climbing plane must be within 80 km of its origin, a low, descending one within 80 km of its destination. If neither fits, that end is replaced by the nearest airport (≈ marker in the UI, hover for the DB value).
- Uithoorn sits under Schiphol's Aalsmeerbaan approach/departure paths, so expect plenty of traffic.
- Colours: red < 600 m, orange < 1.5 km, yellow < 3 km, green < 6 km, blue above; grey = on ground.
