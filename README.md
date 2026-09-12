# RoofRadar 🛩️

Real-time map of every aircraft flying within a configurable radius of your house,
with route (from → to), altitude, speed, heading and climb rate.

- Live positions from [adsb.lol](https://adsb.lol) with automatic failover to [adsb.fi](https://adsb.fi) (free community ADS-B feeds); 429s trigger exponential backoff
- Routes from [hexdb.io](https://hexdb.io) and [adsbdb](https://www.adsbdb.com), airlines from adsbdb (cached per callsign)
- Zero npm dependencies — Node 18+ built-ins only, Leaflet from CDN in the browser
- Smooth motion between polls via dead reckoning, altitude-coloured icons, trails
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
| `radiusKm` | how far around the house to track |
| `pollIntervalMs` | how often to ask adsb.lol (keep ≥ 2000) |
| `port` | HTTP port |

## Notes

- adsb.lol, adsb.fi and adsbdb are free for personal, non-commercial use. adsb.lol rate-limits bursts from one IP; the poller backs off and switches feed automatically (hover the status dot to see which feed is live).
- Routes are looked up by callsign and the databases can be stale (SIA333 is AMS→SIN in hexdb but CDG→SIN in adsbdb). The server asks both and picks the one consistent with the aircraft: a low, climbing plane must be within 80 km of its origin, a low, descending one within 80 km of its destination. If neither fits, that end is replaced by the nearest airport (≈ marker in the UI, hover for the DB value).
- Within 10 km of Uithoorn you also see Schiphol apron traffic; the *hide ground* checkbox filters taxiing aircraft.
- Uithoorn sits under Schiphol's Aalsmeerbaan approach/departure paths, so expect plenty of traffic.
- Colours: red < 600 m, orange < 1.5 km, yellow < 3 km, green < 6 km, blue above; grey = on ground.
