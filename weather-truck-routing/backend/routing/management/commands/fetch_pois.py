"""Builds routing/data/truck_pois.json from OpenStreetMap via Overpass.

Run occasionally (the data changes slowly):
    python manage.py fetch_pois

Shipping a snapshot keeps the API fast and independent of Overpass, whose
public servers frequently time out under load.
"""

import json
import time
from pathlib import Path

import requests
from django.core.management.base import BaseCommand, CommandError

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# kind -> Overpass filter. Truck stops are limited to the national chains that
# reliably have truck parking and diesel lanes.
QUERIES = {
    "weigh_station": '["highway"="weigh_station"]',
    "scale": '["amenity"="weighbridge"]',
    "rest_area": '["highway"="rest_area"]',
    "truck_parking": '["amenity"="parking"]["hgv"="designated"]',
    "truck_stop": '["amenity"="fuel"]["brand"~"^(Pilot|Flying J|Love\'s|TA|Petro|Travel ?Centers of America)",i]',
}

# Contiguous US in 5x5 degree tiles (south, west, north, east).
TILES = [(lat, lon, lat + 5, lon + 5) for lat in range(24, 50, 5) for lon in range(-125, -66, 5)]

OUT = Path(__file__).resolve().parents[2] / "data" / "truck_pois.json"


class Command(BaseCommand):
    help = "Download US weigh stations, scales, rest areas, truck parking and truck stops from OSM."

    def handle(self, *args, **opts):
        session = requests.Session()
        session.headers["User-Agent"] = "weather-truck-routing/1.0 (poi snapshot)"
        pois: dict[str, list] = {}
        for kind, flt in QUERIES.items():
            for tile in TILES:
                bbox = ",".join(str(v) for v in tile)
                q = f"[out:json][timeout:60][bbox:{bbox}];nwr{flt};out center tags;"
                for el in self._run(session, q, f"{kind} {bbox}"):
                    lat = el.get("lat", el.get("center", {}).get("lat"))
                    lon = el.get("lon", el.get("center", {}).get("lon"))
                    if lat is None:
                        continue
                    tags = el.get("tags", {})
                    key = f"{el['type'][0]}{el['id']}"
                    pois[key] = [kind, round(lat, 5), round(lon, 5), tags.get("name") or tags.get("brand") or ""]
            self.stdout.write(f"{kind}: {sum(1 for p in pois.values() if p[0] == kind)}")
        OUT.write_text(json.dumps({"source": "OpenStreetMap contributors (ODbL)", "fetched": time.strftime("%Y-%m-%d"),
                                   "fields": ["kind", "lat", "lon", "name"], "pois": sorted(pois.values())},
                                  separators=(",", ":")))
        self.stdout.write(self.style.SUCCESS(f"wrote {len(pois)} POIs to {OUT}"))

    def _run(self, session, query, label):
        for attempt in range(6):
            url = ENDPOINTS[attempt % len(ENDPOINTS)]
            try:
                r = session.post(url, data={"data": query}, timeout=120)
                if r.status_code == 200:
                    return r.json().get("elements", [])
            except (requests.RequestException, ValueError):
                pass
            time.sleep(2 + attempt * 2)
        raise CommandError(f"Overpass failed for {label}")
