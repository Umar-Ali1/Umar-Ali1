"""Truck points of interest along a route, from a bundled OpenStreetMap snapshot.

The snapshot (``data/truck_pois.json``) is built by ``manage.py fetch_pois``.
It is loaded once per process and bucketed on a coarse grid, so finding the
POIs near a 1,000-mile route takes a few milliseconds.
"""

import json
import logging
import math
from functools import lru_cache
from pathlib import Path

from . import geo

log = logging.getLogger(__name__)

DATA_FILE = Path(__file__).resolve().parent / "data" / "truck_pois.json"
CELL_DEG = 0.1
MAX_OFFSET_MI = 2.0  # POIs further than this from the route aren't "on the way"
KINDS = ("weigh_station", "scale", "rest_area", "truck_parking", "truck_stop")


@lru_cache(maxsize=1)
def _index() -> dict[tuple[int, int], list[tuple[str, float, float, str]]]:
    if not DATA_FILE.exists():
        log.warning("POI snapshot missing (%s); run `manage.py fetch_pois`", DATA_FILE)
        return {}
    grid: dict[tuple[int, int], list] = {}
    for kind, lat, lon, name in json.loads(DATA_FILE.read_text())["pois"]:
        grid.setdefault((int(lon // CELL_DEG), int(lat // CELL_DEG)), []).append((kind, lat, lon, name))
    return grid


def along_route(coords: list[geo.LonLat], seg_distance_m: list[float]) -> list[dict]:
    """POIs within MAX_OFFSET_MI of the route, ordered by route mile.

    Each POI is matched to its nearest sample point (every ~1 km), which gives
    both its distance off-route and the mile at which the truck passes it.
    """
    grid = _index()
    if not grid:
        return []
    cum = geo.cumulative(seg_distance_m)
    step = 1000.0
    samples = geo.resample(coords, cum, step)
    max_off_m = MAX_OFFSET_MI * geo.METERS_PER_MILE
    reach = 1  # neighbouring cells; 0.1° ≥ 2 mi everywhere in the contiguous US

    best: dict[tuple[float, float], dict] = {}
    for k, (lon, lat) in enumerate(samples):
        cx, cy = int(lon // CELL_DEG), int(lat // CELL_DEG)
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                for kind, plat, plon, name in grid.get((cx + dx, cy + dy), ()):
                    d = geo.haversine_m((lon, lat), (plon, plat))
                    if d > max_off_m + step:
                        continue
                    prev = best.get((plat, plon))
                    if prev is None or d < prev["_d"]:
                        best[(plat, plon)] = {
                            "kind": kind,
                            "name": name,
                            "lat": plat,
                            "lon": plon,
                            "_mile_m": k * step,
                            "_d": d,
                        }
    out = sorted((_refine(p, samples, step, cum[-1]) for p in best.values()), key=lambda p: p["mile"])
    return [p for p in out if p["off_route_mi"] <= MAX_OFFSET_MI]


def _refine(p: dict, samples: list[geo.LonLat], step: float, total_m: float) -> dict:
    """Project the POI onto the two sample segments around its nearest sample for
    an exact off-route distance and passing mile (samples are ~1 km apart)."""
    k = round(p.pop("_mile_m") / step) if "_mile_m" in p else 0
    best_d, best_m = p.pop("_d"), min(k * step, total_m)
    for a in (k - 1, k):
        if a < 0 or a + 1 >= len(samples):
            continue
        d, t = _point_segment_m((p["lon"], p["lat"]), samples[a], samples[a + 1])
        if d < best_d:
            best_d, best_m = d, min((a + t) * step, total_m)
    p["off_route_mi"] = round(best_d / geo.METERS_PER_MILE, 2)
    p["mile"] = round(best_m / geo.METERS_PER_MILE, 1)
    return p


def _point_segment_m(p: geo.LonLat, a: geo.LonLat, b: geo.LonLat) -> tuple[float, float]:
    """Distance (m) from p to segment ab and the projection parameter t∈[0,1],
    in a local equirectangular plane (exact enough over ~1 km)."""
    kx = math.cos(math.radians(p[1])) * 111_320
    ky = 110_540
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
    return math.hypot(ax + t * dx, ay + t * dy), t
