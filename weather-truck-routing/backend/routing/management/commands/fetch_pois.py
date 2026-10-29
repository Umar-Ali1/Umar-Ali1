"""Builds routing/data/truck_pois.json from OpenStreetMap via Overpass.

Run occasionally (the data changes slowly):
    python manage.py fetch_pois

Shipping a snapshot keeps the API fast and independent of Overpass, whose
public servers frequently time out under load.

OSM has no dedicated tag for US state weigh stations: they share
``amenity=weighbridge`` with commercial (e.g. CAT) scales, so we classify each
weighbridge from its name, brand and operator.
"""

import json
import re
import time
from pathlib import Path

import requests
from django.core.management.base import BaseCommand, CommandError

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

US_BBOX = (24.0, -125.0, 50.0, -66.0)  # contiguous US (south, west, north, east)

QUERIES = {
    "weighbridge": '["amenity"~"^(weighbridge|weigh_station)$"]',
    "rest_area": '["highway"="rest_area"]',
    "truck_parking": '["amenity"="parking"]["hgv"="designated"]',
    # National chains that reliably have truck parking and diesel lanes.
    "truck_stop": '["amenity"="fuel"]["brand"~"^(Pilot|Flying J|Love\'s|TA|Petro|TravelCenters of America|Travel Centers of America)",i]',
}

COMMERCIAL = re.compile(r"\b(cat|certified|truck stop|travel ?cent|pilot|flying j|love'?s|petro)\b", re.I)
ENFORCEMENT = re.compile(
    r"weigh|port of entry|\bpoe\b|inspection|enforcement|\bdot\b|department of transportation|"
    r"state (police|patrol)|highway patrol|motor carrier",
    re.I,
)

OUT = Path(__file__).resolve().parents[2] / "data" / "truck_pois.json"


def classify_weighbridge(tags: dict) -> str | None:
    """'weigh_station' (state enforcement), 'scale' (commercial) or None (e.g. a quarry scale)."""
    text = " ".join(tags.get(k, "") for k in ("name", "brand", "operator", "description"))
    if tags.get("amenity") == "weigh_station" or (ENFORCEMENT.search(text) and not COMMERCIAL.search(text)):
        return "weigh_station"
    if COMMERCIAL.search(text):
        return "scale"
    return None  # unnamed weighbridges are mostly industrial (quarries, farms, landfills)


class Command(BaseCommand):
    help = "Download US weigh stations, scales, rest areas, truck parking and truck stops from OSM."

    def handle(self, *args, **opts):
        session = requests.Session()
        session.headers["User-Agent"] = "weather-truck-routing/1.0 (poi snapshot)"
        pois: dict[str, list] = {}
        for group, flt in QUERIES.items():
            elements = self._fetch(session, flt, group)
            kept = 0
            for el in elements:
                lat = el.get("lat", el.get("center", {}).get("lat"))
                lon = el.get("lon", el.get("center", {}).get("lon"))
                if lat is None:
                    continue
                tags = el.get("tags", {})
                kind = classify_weighbridge(tags) if group == "weighbridge" else group
                if kind is None:
                    continue
                pois[f"{el['type'][0]}{el['id']}"] = [kind, round(lat, 5), round(lon, 5), tags.get("name") or tags.get("brand") or ""]
                kept += 1
            self.stdout.write(f"{group}: {len(elements)} fetched, {kept} kept")
        if not pois:
            raise CommandError("No POIs fetched; keeping the existing snapshot")
        OUT.parent.mkdir(exist_ok=True)
        OUT.write_text(
            json.dumps(
                {
                    "source": "OpenStreetMap contributors (ODbL)",
                    "fetched": time.strftime("%Y-%m-%d"),
                    "fields": ["kind", "lat", "lon", "name"],
                    "pois": sorted(pois.values()),
                },
                separators=(",", ":"),
            )
        )
        self.stdout.write(self.style.SUCCESS(f"wrote {len(pois)} POIs to {OUT}"))

    def _fetch(self, session, flt: str, label: str) -> list[dict]:
        """One nationwide query; if Overpass rejects it, fall back to 10° tiles."""
        result = self._run(session, self._query(flt, US_BBOX), label, attempts=4)
        if result is not None:
            return result
        s, w, n, e = US_BBOX
        out = []
        for lat in range(int(s), int(n), 10):
            for lon in range(int(w), int(e), 10):
                tile = (lat, lon, min(lat + 10, n), min(lon + 10, e))
                part = self._run(session, self._query(flt, tile), f"{label} {tile}", attempts=8)
                if part is None:
                    raise CommandError(f"Overpass failed for {label} {tile}")
                out += part
        return out

    @staticmethod
    def _query(flt: str, bbox) -> str:
        return f"[out:json][timeout:180][bbox:{','.join(map(str, bbox))}];nwr{flt};out center tags;"

    def _run(self, session, query: str, label: str, attempts: int) -> list | None:
        for attempt in range(attempts):
            url = ENDPOINTS[attempt % len(ENDPOINTS)]
            try:
                r = session.post(url, data={"data": query}, timeout=200)
                if r.status_code == 200:
                    data = r.json()
                    # Overpass reports server-side timeouts inside a 200 response.
                    if "remark" not in data or "runtime error" not in data["remark"]:
                        return data.get("elements", [])
                self.stdout.write(f"  {label}: {url.split('/')[2]} -> HTTP {r.status_code}")
            except (requests.RequestException, ValueError) as exc:
                self.stdout.write(f"  {label}: {url.split('/')[2]} -> {type(exc).__name__}")
            time.sleep(3 + attempt * 3)
        return None
