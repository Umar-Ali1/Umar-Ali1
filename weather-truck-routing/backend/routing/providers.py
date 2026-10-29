"""Thin clients for the third-party APIs: Nominatim (geocoding), OSRM (routing)
and Open-Meteo (hourly forecast). All are keyless; base URLs are configurable."""

import hashlib
import json
import logging
import math
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests
from django.conf import settings
from django.core.cache import cache
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)


class ProviderError(Exception):
    """An upstream API failed or returned something unusable."""


def _session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=2, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504))
    s.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=16))
    s.headers["User-Agent"] = settings.HTTP_USER_AGENT
    return s


_http = _session()


def _get_json(url: str, params: dict | None = None) -> dict | list:
    try:
        resp = _http.get(url, params=params, timeout=settings.HTTP_TIMEOUT_SECONDS)
    except requests.RequestException as exc:
        raise ProviderError(f"{url}: {exc}") from exc
    if resp.status_code >= 400:
        raise ProviderError(f"{url}: HTTP {resp.status_code} {resp.text[:200]}")
    return resp.json()


def _cache_key(prefix: str, payload) -> str:
    digest = hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return f"{prefix}:{digest}"


# --- Geocoding ---------------------------------------------------------------

_LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def geocode(query: str) -> dict:
    """Resolve free text (or a raw "lat, lon") to {name, lat, lon}. US-biased."""
    m = _LATLON.match(query)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            return {"name": query.strip(), "lat": lat, "lon": lon}
    results = search_places(query, limit=1)
    if not results:
        raise ProviderError(f"Could not find a location for '{query}'")
    return results[0]


def search_places(query: str, limit: int = 5) -> list[dict]:
    key = _cache_key("geo", [query.lower().strip(), limit])
    if (hit := cache.get(key)) is not None:
        return hit
    data = _get_json(
        f"{settings.NOMINATIM_BASE_URL}/search",
        {"q": query, "format": "jsonv2", "limit": limit, "countrycodes": "us,ca,mx"},
    )
    results = [{"name": d["display_name"], "lat": float(d["lat"]), "lon": float(d["lon"])} for d in data]
    cache.set(key, results, 24 * 3600)
    return results


# --- Routing -----------------------------------------------------------------


def osrm_routes(waypoints: list[tuple[float, float]], alternatives: int = 0) -> list[dict]:
    """Driving routes through ``waypoints`` (lon, lat). Each route carries full
    GeoJSON geometry plus per-segment distance/duration annotations."""
    coords = ";".join(f"{lon:.5f},{lat:.5f}" for lon, lat in waypoints)
    params = {
        "overview": "full",
        "geometries": "geojson",
        "annotations": "distance,duration",
        "steps": "false",
        "alternatives": str(alternatives) if alternatives else "false",
    }
    key = _cache_key("osrm", [coords, params])
    if (hit := cache.get(key)) is not None:
        return hit
    data = _get_json(f"{settings.OSRM_BASE_URL}/route/v1/driving/{coords}", params)
    if data.get("code") != "Ok":
        raise ProviderError(f"OSRM: {data.get('code')} {data.get('message', '')}")
    routes = []
    for r in data["routes"]:
        seg_dist, seg_dur = [], []
        for leg in r["legs"]:
            seg_dist += leg["annotation"]["distance"]
            seg_dur += leg["annotation"]["duration"]
        coords_ll = [tuple(c) for c in r["geometry"]["coordinates"]]
        # Multi-leg routes repeat the via point at the leg boundary; annotations do not.
        coords_ll = _dedupe_consecutive(coords_ll)
        if len(coords_ll) != len(seg_dist) + 1:
            coords_ll = coords_ll[: len(seg_dist) + 1]
        routes.append(
            {
                "coords": coords_ll,
                "seg_distance_m": seg_dist,
                "seg_duration_s": seg_dur,
                "distance_m": r["distance"],
                "duration_s": r["duration"],
                "summary": " / ".join(leg.get("summary", "") for leg in r["legs"] if leg.get("summary")),
            }
        )
    cache.set(key, routes, 6 * 3600)
    return routes


def _dedupe_consecutive(coords: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = [coords[0]]
    for c in coords[1:]:
        if c != out[-1]:
            out.append(c)
    return out


# --- Weather -----------------------------------------------------------------

# `rain` is large-scale (stratiform) rain only; convective downpours arrive as `showers`.
HOURLY_VARS = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall", "precipitation")
MAX_FORECAST_DAYS = 16
BATCH_SIZE = 100  # locations per Open-Meteo request (URL length safe)


def round_coord(v: float) -> float:
    """~5 km grid. Open-Meteo's models are 3–11 km, so finer adds nothing but calls."""
    return round(v * 20) / 20


class HourlyForecast:
    """Hourly series for one location; indexes by UTC epoch hour."""

    def __init__(self, start_epoch_h: int, series: dict[str, list[float | None]]):
        self.start = start_epoch_h
        self.series = series
        self.length = len(next(iter(series.values()), []))

    def _value(self, var: str, idx: int) -> float | None:
        if 0 <= idx < self.length:
            v = self.series[var][idx]
            return None if v is None else float(v)
        return None

    def at(self, when: datetime) -> dict | None:
        """Conditions at ``when``.

        Wind is linearly interpolated between hourly samples. Open-Meteo rain and
        snowfall are *preceding-hour* sums, so the hour ending at/after ``when`` is
        the rate the truck drives through.
        """
        t_h = when.timestamp() / 3600 - self.start
        lo = math.floor(t_h)
        frac = t_h - lo
        precip_idx = math.ceil(t_h)

        def lerp(var: str) -> float | None:
            a, b = self._value(var, lo), self._value(var, lo + 1)
            if a is None:
                return b if frac > 0.5 else None
            if b is None:
                return a
            return a + (b - a) * frac

        wind = lerp("wind_speed_10m")
        rain = self._value("rain", precip_idx)
        showers = self._value("showers", precip_idx)
        if rain is not None and showers is not None:
            rain += showers
        snow = self._value("snowfall", precip_idx)
        if wind is None or rain is None or snow is None:
            return None
        return {
            "wind_mph": round(wind, 1),
            "gust_mph": round(lerp("wind_gusts_10m") or 0.0, 1),
            "rain_in_hr": round(rain, 3),
            "snow_in_hr": round(snow, 3),
            "precip_in_hr": round(self._value("precipitation", precip_idx) or 0.0, 3),
        }


def _hour_floor(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def fetch_forecasts(
    points: list[tuple[float, float]], start: datetime, end: datetime
) -> dict[tuple[float, float], HourlyForecast]:
    """Hourly forecasts for every (lon, lat) between ``start`` and ``end``.

    Points are snapped to a ~5 km grid and de-duplicated, then fetched in
    parallel batches. Keys of the returned dict are the *snapped* coordinates;
    use ``round_coord`` to look a point up.
    """
    start_h, end_h = _hour_floor(start), _hour_floor(end) + timedelta(hours=1)
    unique = sorted({(round_coord(lon), round_coord(lat)) for lon, lat in points})
    if settings.WEATHER_PROVIDER == "mock":
        return _mock_forecasts(unique, start_h, end_h)
    out: dict[tuple[float, float], HourlyForecast] = {}
    missing = []
    for p in unique:
        hit = cache.get(_cache_key("wx", [p, start_h.isoformat(), end_h.isoformat()]))
        if hit is not None:
            out[p] = hit
        else:
            missing.append(p)

    batches = [missing[i : i + BATCH_SIZE] for i in range(0, len(missing), BATCH_SIZE)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch, result in zip(batches, pool.map(lambda b: _fetch_batch(b, start_h, end_h), batches)):
            for p, fc in zip(batch, result):
                out[p] = fc
                cache.set(_cache_key("wx", [p, start_h.isoformat(), end_h.isoformat()]), fc, 30 * 60)
    return out


def _fetch_batch(batch: list[tuple[float, float]], start_h: datetime, end_h: datetime) -> list[HourlyForecast]:
    fmt = "%Y-%m-%dT%H:%M"
    data = _get_json(
        f"{settings.OPEN_METEO_BASE_URL}/v1/forecast",
        {
            "latitude": ",".join(f"{lat}" for _, lat in batch),
            "longitude": ",".join(f"{lon}" for lon, _ in batch),
            "hourly": ",".join(HOURLY_VARS),
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",  # also converts snowfall to inches
            "timezone": "GMT",
            "timeformat": "unixtime",
            "start_hour": start_h.strftime(fmt),
            "end_hour": end_h.strftime(fmt),
        },
    )
    items = data if isinstance(data, list) else [data]
    if len(items) != len(batch):
        raise ProviderError(f"Open-Meteo returned {len(items)} locations for {len(batch)}")
    forecasts = []
    for item in items:
        hourly = item.get("hourly") or {}
        times = hourly.get("time") or []
        if not times:
            raise ProviderError("Open-Meteo returned no hourly data")
        forecasts.append(HourlyForecast(int(times[0]) // 3600, {v: hourly.get(v, []) for v in HOURLY_VARS}))
    return forecasts


def _mock_forecasts(points, start_h: datetime, end_h: datetime) -> dict[tuple[float, float], HourlyForecast]:
    """Deterministic storm cell drifting east across the middle of the requested
    area — lets the risk/recommendation pipeline be exercised without network."""
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    c_lon0, c_lat = (min(lons) + max(lons)) / 2 - 1.5, (min(lats) + max(lats)) / 2
    hours = int((end_h - start_h).total_seconds() // 3600) + 1
    base_h = int(start_h.timestamp()) // 3600
    out = {}
    for lon, lat in points:
        wind, gust, rain, snow, precip = [], [], [], [], []
        for h in range(hours):
            c_lon = c_lon0 + 0.12 * h  # ~6 mph drift east
            d2 = ((lon - c_lon) * math.cos(math.radians(lat))) ** 2 + (lat - c_lat) ** 2
            core = math.exp(-d2 / 0.8)
            w = 8 + 50 * core
            r = 0.9 * core if lat < c_lat + 0.3 else 0.0
            s = 2.5 * core if lat >= c_lat + 0.3 else 0.0
            wind.append(round(w, 1)), gust.append(round(w * 1.35, 1))
            rain.append(round(r, 3)), snow.append(round(s, 3)), precip.append(round(r + s / 10, 3))
        out[(lon, lat)] = HourlyForecast(
            base_h,
            {
                "wind_speed_10m": wind,
                "wind_gusts_10m": gust,
                "rain": rain,
                "showers": [0.0] * hours,
                "snowfall": snow,
                "precipitation": precip,
            },
        )
    return out
