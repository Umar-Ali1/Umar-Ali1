"""Small, dependency-free geometry helpers."""

import math
from bisect import bisect_left

EARTH_RADIUS_M = 6_371_008.8
METERS_PER_MILE = 1609.344

LonLat = tuple[float, float]


def haversine_m(a: LonLat, b: LonLat) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def cumulative(values: list[float]) -> list[float]:
    out, total = [0.0], 0.0
    for v in values:
        total += v
        out.append(total)
    return out


def interpolate_along(coords: list[LonLat], cum: list[float], target: float) -> tuple[LonLat, int, float]:
    """Point at ``target`` along a polyline whose vertex positions are ``cum``.

    Returns (point, segment_index, fraction_within_segment).
    """
    if target <= 0:
        return coords[0], 0, 0.0
    if target >= cum[-1]:
        return coords[-1], len(coords) - 2, 1.0
    i = max(bisect_left(cum, target) - 1, 0)
    seg = cum[i + 1] - cum[i]
    f = 0.0 if seg == 0 else (target - cum[i]) / seg
    a, b = coords[i], coords[i + 1]
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f), i, f


def simplify(coords: list[LonLat], tolerance_deg: float = 0.0004) -> list[LonLat]:
    """Ramer-Douglas-Peucker (iterative) — shrinks route payloads ~10x for the map."""
    n = len(coords)
    if n < 3:
        return list(coords)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tolerance_deg**2
    while stack:
        start, end = stack.pop()
        ax, ay = coords[start]
        bx, by = coords[end]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(start + 1, end):
            px, py = coords[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2:
            keep[worst_i] = True
            stack.append((start, worst_i))
            stack.append((worst_i, end))
    return [c for c, k in zip(coords, keep) if k]


def resample(coords: list[LonLat], cum_m: list[float], step_m: float) -> list[LonLat]:
    """Points every ``step_m`` metres along the line (used for overlap checks)."""
    if cum_m[-1] == 0:
        return [coords[0]]
    steps = int(cum_m[-1] // step_m)
    return [interpolate_along(coords, cum_m, k * step_m)[0] for k in range(steps + 1)] + [coords[-1]]


def overlap_ratio(candidate: list[LonLat], existing: list[LonLat], radius_m: float = 1500) -> float:
    """Share of ``candidate`` sample points lying within ``radius_m`` of ``existing``.

    Uses a coarse lat/lon grid hash so this is ~O(n) instead of O(n*m).
    """
    if not candidate or not existing:
        return 0.0
    cell = radius_m / 111_000  # degrees, generous at higher latitudes
    grid: dict[tuple[int, int], list[LonLat]] = {}
    for p in existing:
        grid.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append(p)
    hits = 0
    for p in candidate:
        cx, cy = int(p[0] // cell), int(p[1] // cell)
        near = (
            q
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for q in grid.get((cx + dx, cy + dy), ())
        )
        if any(haversine_m(p, q) <= radius_m for q in near):
            hits += 1
    return hits / len(candidate)


def offset_point(a: LonLat, b: LonLat, along: float, offset_frac: float) -> LonLat:
    """Point ``along`` (0..1) the straight a→b line, pushed sideways by
    ``offset_frac`` of the a→b distance (positive = left of travel direction)."""
    mid_lon = a[0] + (b[0] - a[0]) * along
    mid_lat = a[1] + (b[1] - a[1]) * along
    # Work in a locally-scaled plane so the perpendicular is a true right angle.
    kx = math.cos(math.radians(mid_lat))
    dx, dy = (b[0] - a[0]) * kx, b[1] - a[1]
    length = math.hypot(dx, dy) or 1.0
    px, py = -dy / length, dx / length
    dist = length * offset_frac
    return (mid_lon + px * dist / kx, mid_lat + py * dist)
