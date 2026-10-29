"""Trip planning: route options → checkpoints with ETAs → weather risk → recommendation."""

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from django.conf import settings

from . import geo, hos, providers
from .risk import Risk, assess

log = logging.getLogger(__name__)

ROUTE_OPTIONS = 3
MAX_DETOUR_FACTOR = 1.6  # synthesized alternatives may be at most 60% slower than the fastest
MAX_OVERLAP = 0.8  # an alternative must differ from every other by > 20% of its length
FORECAST_HORIZON = timedelta(days=providers.MAX_FORECAST_DAYS - 1)


@dataclass
class TripRequest:
    origin: dict  # {name, lat, lon}
    destination: dict
    departure: datetime
    load_lb: float
    interval_mi: int
    apply_hos: bool = True


# --- Route options -----------------------------------------------------------


def _truckify(route: dict) -> dict:
    """Trucks can't do 75+ mph; cap each segment's speed to TRUCK_MAX_SPEED_MPH."""
    cap_mps = settings.TRUCK_MAX_SPEED_MPH * geo.METERS_PER_MILE / 3600
    durations = [max(t, d / cap_mps) for d, t in zip(route["seg_distance_m"], route["seg_duration_s"])]
    return {**route, "seg_duration_s": durations, "duration_s": sum(durations)}


def get_route_options(origin: geo.LonLat, dest: geo.LonLat) -> list[dict]:
    """Up to three meaningfully different routes.

    OSRM's alternatives often return only 1–2 routes on long trips, so we fill the
    gap by forcing routes through via points offset to either side of the
    origin→destination line, keeping only ones that are distinct and not absurd.
    """
    routes = [_truckify(r) for r in providers.osrm_routes([origin, dest], alternatives=ROUTE_OPTIONS)]
    if not routes:
        raise providers.ProviderError("No route found between these locations")
    for r in routes:
        r["source"] = "osrm"

    if len(routes) < ROUTE_OPTIONS:
        vias = [
            geo.offset_point(origin, dest, along, side * frac)
            for frac in (0.12, 0.22)
            for along in (0.5, 0.35, 0.65)
            for side in (1, -1)
        ]

        def fetch(via):
            try:
                return providers.osrm_routes([origin, via, dest])
            except providers.ProviderError as exc:
                log.info("via route failed: %s", exc)
                return []

        with ThreadPoolExecutor(max_workers=4) as pool:
            candidates = [_truckify(r) for found in pool.map(fetch, vias) for r in found]
        fastest = min(r["duration_s"] for r in routes)
        for cand in sorted(candidates, key=lambda r: r["duration_s"]):
            if len(routes) >= ROUTE_OPTIONS:
                break
            if cand["duration_s"] > fastest * MAX_DETOUR_FACTOR:
                continue
            if all(_overlap(cand, r) < MAX_OVERLAP for r in routes):
                cand["source"] = "via"
                routes.append(cand)

    routes.sort(key=lambda r: r["duration_s"])
    return routes[:ROUTE_OPTIONS]


def _samples(route: dict, step_m: float = 2000) -> list[geo.LonLat]:
    if "_samples" not in route:
        route["_samples"] = geo.resample(route["coords"], geo.cumulative(route["seg_distance_m"]), step_m)
    return route["_samples"]


def _overlap(a: dict, b: dict) -> float:
    return geo.overlap_ratio(_samples(a), _samples(b))


# --- Checkpoints -------------------------------------------------------------


def build_checkpoints(route: dict, req: TripRequest) -> tuple[list[dict], list[dict], float]:
    """Checkpoints every ``interval_mi`` (plus origin and destination), each with
    its arrival time, and the HOS stops. Returns (checkpoints, stops, total_s)."""
    coords = route["coords"]
    cum_m = geo.cumulative(route["seg_distance_m"])
    cum_s = geo.cumulative(route["seg_duration_s"])
    total_m, total_drive_s = cum_m[-1], cum_s[-1]
    stops = hos.plan_stops(total_drive_s) if req.apply_hos else []

    step_m = req.interval_mi * geo.METERS_PER_MILE
    marks = [k * step_m for k in range(int(total_m // step_m) + 1)]
    if total_m - marks[-1] > step_m * 0.1 or len(marks) == 1:
        marks.append(total_m)
    else:
        marks[-1] = total_m  # destination absorbs a tiny final stub

    def drive_time_at(dist_m: float) -> float:
        _, i, f = geo.interpolate_along(coords, cum_m, dist_m)
        return cum_s[i] + (cum_s[i + 1] - cum_s[i]) * f

    checkpoints = []
    for idx, d in enumerate(marks):
        point, _, _ = geo.interpolate_along(coords, cum_m, d)
        drive_s = drive_time_at(d)
        elapsed = hos.elapsed_for(drive_s, stops)
        # Each checkpoint represents half the gap to each neighbour, so miles sum to the route length.
        prev_d = marks[idx - 1] if idx else d
        next_d = marks[idx + 1] if idx + 1 < len(marks) else d
        checkpoints.append(
            {
                "index": idx,
                "lon": round(point[0], 5),
                "lat": round(point[1], 5),
                "mile": round(d / geo.METERS_PER_MILE, 1),
                "represents_mi": (next_d - prev_d) / 2 / geo.METERS_PER_MILE,
                "elapsed_s": round(elapsed),
                "eta": (req.departure + timedelta(seconds=elapsed)).isoformat(),
            }
        )

    stop_out = []
    for s in stops:
        # Locate the stop: the distance at which cumulative driving time hits the offset.
        j = min(range(len(cum_s)), key=lambda k: abs(cum_s[k] - s.driving_offset_s))
        stop_out.append(
            {
                "kind": s.kind,
                "lon": round(coords[j][0], 5),
                "lat": round(coords[j][1], 5),
                "mile": round(cum_m[j] / geo.METERS_PER_MILE, 1),
                "start": (req.departure + timedelta(seconds=hos.elapsed_for(s.driving_offset_s, stops))).isoformat(),
                "duration_h": s.duration_s / 3600,
            }
        )
    return checkpoints, stop_out, hos.elapsed_for(total_drive_s, stops)


# --- Scoring & recommendation ------------------------------------------------


def summarize(checkpoints: list[dict]) -> dict:
    miles = {lvl.name.lower(): 0.0 for lvl in Risk}
    miles["unknown"] = 0.0
    weighted, known = 0.0, 0.0
    worst = Risk.LOW
    for cp in checkpoints:
        w = cp["represents_mi"]
        risk = cp.get("risk")
        if risk is None:
            miles["unknown"] += w
            continue
        lvl = Risk(risk["level"])
        miles[lvl.name.lower()] += w
        weighted += w * lvl
        known += w
        worst = max(worst, lvl)
    return {
        "miles_by_level": {k: round(v, 1) for k, v in miles.items()},
        "avg_risk": round(weighted / known, 3) if known else None,
        "max_level": int(worst),
        "max_label": worst.label,
    }


def rank_key(route: dict) -> tuple:
    """The spec's preference order, with No Travel miles (worse than Severe) first.

    Miles are rounded to 0.1 and average risk to 0.01 so sampling noise can't
    decide between routes that are effectively tied; travel time breaks the tie.
    """
    s = route["summary"]
    m = s["miles_by_level"]
    return (
        round(m["no_travel"], 1),
        round(m["severe"], 1),
        round(m["high"], 1),
        # Miles with no forecast (beyond the model horizon) must never make a route look safer.
        round(m["unknown"], 1),
        round(s["avg_risk"] if s["avg_risk"] is not None else 99, 2),
        route["duration_s"],
    )


_CRITERIA = ("No Travel miles", "Severe miles", "High miles", "unforecast miles", "average risk", "travel time")


def recommend(routes: list[dict]) -> dict:
    ranked = sorted(routes, key=rank_key)
    best = ranked[0]
    for i, r in enumerate(ranked):
        r["rank"] = i + 1
    if len(ranked) == 1:
        reason = "Only one route was available."
    else:
        runner = ranked[1]
        a, b = rank_key(best), rank_key(runner)
        k = next((i for i in range(len(a)) if a[i] != b[i]), len(a) - 1)
        if k == 5:
            diff = (b[5] - a[5]) / 60
            reason = f"Equal weather risk to {runner['name']}; {diff:.0f} min faster."
        elif k == 4:
            reason = f"Lower average risk ({a[4]:.2f} vs {b[4]:.2f} on {runner['name']})."
        else:
            reason = f"Fewer {_CRITERIA[k]} ({a[k]:.0f} vs {b[k]:.0f} mi on {runner['name']})."
        if best["summary"]["miles_by_level"]["no_travel"] > 0:
            reason = "No route is safe: every option crosses No Travel conditions. " + reason
    return {"route_id": best["id"], "reason": reason}


# --- Orchestration -----------------------------------------------------------


def plan_trip(req: TripRequest) -> dict:
    origin = (req.origin["lon"], req.origin["lat"])
    dest = (req.destination["lon"], req.destination["lat"])
    raw_routes = get_route_options(origin, dest)

    routes = []
    for i, r in enumerate(raw_routes):
        checkpoints, stops, total_s = build_checkpoints(r, req)
        routes.append(
            {
                "id": f"route-{i + 1}",
                "name": f"Route {chr(65 + i)}",
                "source": r["source"],
                "distance_mi": round(r["distance_m"] / geo.METERS_PER_MILE, 1),
                "driving_s": round(r["duration_s"]),
                "duration_s": round(total_s),
                "arrival": (req.departure + timedelta(seconds=total_s)).isoformat(),
                "geometry": [[round(lat, 5), round(lon, 5)] for lon, lat in geo.simplify(r["coords"])],
                "checkpoints": checkpoints,
                "stops": stops,
            }
        )

    attach_weather(routes, req)
    for r in routes:
        r["summary"] = summarize(r["checkpoints"])
        for cp in r["checkpoints"]:
            cp["represents_mi"] = round(cp["represents_mi"], 2)
    recommendation = recommend(routes)
    return {
        "origin": req.origin,
        "destination": req.destination,
        "departure": req.departure.isoformat(),
        "load_lb": req.load_lb,
        "interval_mi": req.interval_mi,
        "hos_applied": req.apply_hos,
        "weather_source": settings.WEATHER_PROVIDER,
        "routes": routes,
        "recommendation": recommendation,
    }


def attach_weather(routes: list[dict], req: TripRequest) -> None:
    now = datetime.now(timezone.utc)
    horizon = now + FORECAST_HORIZON
    all_cps = [cp for r in routes for cp in r["checkpoints"]]
    in_range = [cp for cp in all_cps if datetime.fromisoformat(cp["eta"]) <= horizon]
    if not in_range:
        return
    latest = max(datetime.fromisoformat(cp["eta"]) for cp in in_range)
    forecasts = providers.fetch_forecasts([(cp["lon"], cp["lat"]) for cp in in_range], req.departure, latest)
    for cp in in_range:
        fc = forecasts.get((providers.round_coord(cp["lon"]), providers.round_coord(cp["lat"])))
        wx = fc.at(datetime.fromisoformat(cp["eta"])) if fc else None
        cp["weather"] = wx
        cp["risk"] = (
            assess(wx["wind_mph"], wx["rain_in_hr"], wx["snow_in_hr"], req.load_lb).as_dict() if wx else None
        )


# --- Corridor heatmap --------------------------------------------------------

HEATMAP_HOURS = 48
HEATMAP_MAX_CELLS = 260
CORRIDOR_RADIUS_MI = 35


def corridor_heatmap(corridor: list[geo.LonLat], departure: datetime, load_lb: float) -> dict:
    """Hourly 0–48 h forecast on a lat/lon grid hugging the routes.

    Every hour is returned in one response so the slider re-colours client-side
    with no further network calls.
    """
    lons = [p[0] for p in corridor]
    lats = [p[1] for p in corridor]
    pad = 0.4
    west, east, south, north = min(lons) - pad, max(lons) + pad, min(lats) - pad, max(lats) + pad

    radius_m = CORRIDOR_RADIUS_MI * geo.METERS_PER_MILE
    # Pick the finest spacing whose in-corridor cell count fits the budget.
    spacing = 0.15
    while True:
        cells = _corridor_cells(corridor, west, east, south, north, spacing, radius_m)
        if len(cells) <= HEATMAP_MAX_CELLS:
            break
        spacing *= 1.2

    start = departure.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=HEATMAP_HOURS)
    forecasts = providers.fetch_forecasts(cells, start, end)

    hours = [start + timedelta(hours=h) for h in range(HEATMAP_HOURS + 1)]
    wind, rain, snow, risk = [], [], [], []
    for lon, lat in cells:
        fc = forecasts[(providers.round_coord(lon), providers.round_coord(lat))]
        w_row, r_row, s_row, k_row = [], [], [], []
        for t in hours:
            wx = fc.at(t)
            if wx is None:
                w_row.append(None), r_row.append(None), s_row.append(None), k_row.append(None)
                continue
            w_row.append(wx["wind_mph"])
            r_row.append(wx["rain_in_hr"])
            s_row.append(wx["snow_in_hr"])
            k_row.append(int(assess(wx["wind_mph"], wx["rain_in_hr"], wx["snow_in_hr"], load_lb).level))
        wind.append(w_row), rain.append(r_row), snow.append(s_row), risk.append(k_row)

    return {
        "weather_source": settings.WEATHER_PROVIDER,
        "spacing_deg": round(spacing, 4),
        "start": start.isoformat(),
        "hours": [t.isoformat() for t in hours],
        "cells": [[round(lat, 4), round(lon, 4)] for lon, lat in cells],
        "wind_mph": wind,
        "rain_in_hr": rain,
        "snow_in_hr": snow,
        "risk": risk,
    }


def _corridor_cells(corridor, west, east, south, north, spacing, radius_m) -> list[geo.LonLat]:
    cells = []
    n_lat = max(1, math.ceil((north - south) / spacing))
    n_lon = max(1, math.ceil((east - west) / spacing))
    # Bucket corridor points so each cell checks only nearby ones.
    bucket = spacing * 2
    grid: dict[tuple[int, int], list[geo.LonLat]] = {}
    for p in corridor:
        grid.setdefault((int(p[0] // bucket), int(p[1] // bucket)), []).append(p)
    reach = math.ceil((radius_m / 111_000) / bucket / max(math.cos(math.radians((north + south) / 2)), 0.3)) + 1
    for i in range(n_lat + 1):
        lat = south + i * spacing
        for j in range(n_lon + 1):
            lon = west + j * spacing
            bx, by = int(lon // bucket), int(lat // bucket)
            near = (
                q
                for dx in range(-reach, reach + 1)
                for dy in range(-reach, reach + 1)
                for q in grid.get((bx + dx, by + dy), ())
            )
            if any(geo.haversine_m((lon, lat), q) <= radius_m for q in near):
                cells.append((lon, lat))
    return cells
